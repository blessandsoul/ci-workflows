// Deploys one repository's Coolify applications AFTER CI has passed, in order, following every deployment to its end and probing the site.
//
// Why a script and not a few curl lines: this is the part that changes production, so it has to be testable offline (the unit tests run it against a
// fake Coolify server) and every decision below has a reason that must stay true:
//  * Coolify deploys the LATEST commit of the configured branch, not the commit CI tested. If the branch moved on after CI went green, this run does
//    nothing: the newer commit gets its own CI run and its own CD run. (Without this check a red commit could be deployed by an older green run.)
//  * Apps are deployed one after the other, in the order given (server before client). The first failure stops the run, later apps are not touched.
//  * "Accepted" is not "deployed": every deployment is followed until it is finished, failed, cancelled or timed out, and a finished build is only
//    reported as deployed once the site answers.
//  * The token is only sent to the HTTPS Coolify URL, redirects are refused (a redirected bearer request could leak it), and it is never printed.
//
// No dependencies: plain Node, so it runs on any GitHub runner and under `node --test`.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const UUID = /^[A-Za-z0-9_-]{8,64}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
// Escape sequences and control characters: text from a server must never be able to move the cursor or fake a log line.
const CONTROL = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

export class DeployError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Text that is safe to print: no control characters, bounded length. */
export function safe(value, max = 200) {
  return String(value ?? '').replace(CONTROL, '').slice(0, max);
}

/** Coolify's deployment status words mapped to queued | running | succeeded | failed | cancelled | unknown (same mapping as the Python deploy tool). */
export function deploymentState(status) {
  const word = String(status ?? '').trim().toLowerCase();
  if (['queued', 'pending', 'waiting'].includes(word)) return 'queued';
  if (['in_progress', 'running', 'building', 'deploying'].includes(word)) return 'running';
  if (['finished', 'success', 'successful', 'completed', 'deployed'].includes(word)) return 'succeeded';
  if (['failed', 'error'].includes(word)) return 'failed';
  if (word.startsWith('cancel')) return 'cancelled';
  return 'unknown';
}

/** Queued or running deployments that belong to this application (a deployment's URL embeds the application's UUID). */
export function activeFor(rows, uuid) {
  const list = Array.isArray(rows) ? rows : Array.isArray(rows?.deployments) ? rows.deployments : [];
  return list.filter((row) => row && ['in_progress', 'queued'].includes(row.status) && String(row.deployment_url ?? '').includes(uuid));
}

/** The https URLs to probe for an application: every https domain of `fqdn` plus the health path (default `/`). Plain http domains are not probed. */
export function publicUrls(fqdn, healthPath) {
  const path = typeof healthPath === 'string' && healthPath.startsWith('/') && !healthPath.startsWith('//') && !/[\r\n]/.test(healthPath) ? healthPath : '/';
  const urls = [];
  for (const raw of String(fqdn ?? '').split(',')) {
    try {
      const url = new URL(raw.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) continue;
      urls.push(`${url.origin}${url.pathname.replace(/\/+$/, '')}${path}`);
    } catch {
      /* not a URL: skip */
    }
  }
  return urls;
}

/** Validates the run's inputs (all arrive as environment text) and applies defaults. Throws DeployError with a message a person can act on. */
export function parseConfig(env) {
  const dryRun = env.DRY_RUN === '1';
  let base;
  try {
    base = new URL(String(env.COOLIFY_URL ?? '').trim());
  } catch {
    throw new DeployError('config', 'COOLIFY_URL is not a valid URL.');
  }
  if (base.protocol !== 'https:') throw new DeployError('config', 'The Coolify URL must be https:// (the token would travel in clear text over http).');
  if (base.username || base.password || base.search || base.hash) throw new DeployError('config', 'The Coolify URL must not contain credentials, a query or a fragment.');
  const token = String(env.COOLIFY_TOKEN ?? '').trim();
  if (!token) throw new DeployError('config', 'COOLIFY_TOKEN is empty (the repository secret is missing).');
  let apps;
  try {
    apps = JSON.parse(env.APPS ?? '');
  } catch {
    throw new DeployError('config', 'APPS is not valid JSON.');
  }
  if (!Array.isArray(apps) || !apps.length) throw new DeployError('config', 'APPS must list at least one application.');
  apps = apps.map((app) => {
    if (!app || !UUID.test(String(app.uuid ?? ''))) throw new DeployError('config', 'An application in APPS has no valid uuid.');
    return { uuid: String(app.uuid), name: safe(app.name || app.uuid, 60) };
  });
  const expectedSha = String(env.EXPECTED_SHA ?? '').trim().toLowerCase();
  if (!SHA.test(expectedSha) && !(dryRun && !expectedSha)) throw new DeployError('config', 'EXPECTED_SHA must be the 40-character commit that CI tested.');
  const repo = String(env.GITHUB_REPOSITORY ?? '').trim();
  const branch = String(env.BRANCH ?? '').trim();
  if (!REPO.test(repo)) throw new DeployError('config', 'GITHUB_REPOSITORY must look like owner/name.');
  if (!BRANCH.test(branch)) throw new DeployError('config', 'BRANCH is not a usable branch name.');
  const seconds = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) * 1000 : fallback);
  return {
    base: base.origin,
    token,
    apps,
    expectedSha,
    repo,
    branch,
    dryRun,
    pollMs: seconds(env.POLL_SECONDS, 10_000),
    deployTimeoutMs: seconds(env.DEPLOY_TIMEOUT_SECONDS, 15 * 60_000),
    idleTimeoutMs: seconds(env.IDLE_TIMEOUT_SECONDS, 15 * 60_000),
    healthTimeoutMs: seconds(env.HEALTH_TIMEOUT_SECONDS, 3 * 60_000),
  };
}

/** The real network and clock; tests replace any of these. */
export function realDeps() {
  return {
    fetch: (url, options) => fetch(url, { signal: AbortSignal.timeout(20_000), ...options }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    log: (line) => console.log(line),
    /** The commit the branch points at right now, read from GitHub. Throws when it cannot be read: not knowing means not deploying. */
    async branchHead(repo, branch) {
      const response = await fetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
        headers: { Accept: 'application/vnd.github.sha', 'X-GitHub-Api-Version': '2022-11-28', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new DeployError('head_unreadable', `GitHub answered ${response.status} when reading the head of ${branch}.`);
      return (await response.text()).trim().toLowerCase();
    },
    /** One probe of a public URL: the HTTP status, or a short error word. 3xx counts as up (no redirect is followed). */
    async probe(url) {
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'ci-workflows-cd-health' } });
        return response.status;
      } catch (error) {
        return safe(error?.cause?.code || error?.name || 'error', 40);
      }
    },
  };
}

async function coolify(ctx, path, { method = 'GET' } = {}) {
  let response;
  try {
    response = await ctx.d.fetch(`${ctx.config.base}/api/v1${path}`, {
      method,
      redirect: 'error', // a redirect would carry the bearer token to another host
      headers: { Authorization: `Bearer ${ctx.config.token}`, Accept: 'application/json' },
    });
  } catch (error) {
    throw new DeployError('network', `Could not reach Coolify (${safe(error?.cause?.code || error?.message || 'error', 80)}).`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* some endpoints answer plain text */
  }
  if (!response.ok) {
    const detail = safe(json?.message ?? '', 120);
    if (response.status === 401 || response.status === 403) throw new DeployError('auth', `Coolify refused the token (HTTP ${response.status}${detail ? `: ${detail}` : ''}).`);
    throw new DeployError('http', `Coolify answered HTTP ${response.status}${detail ? `: ${detail}` : ''} for ${method} ${path.split('?')[0].replace(/[A-Za-z0-9_-]{20,}/g, '<id>')}.`);
  }
  return json ?? text;
}

/** Waits until this application has no queued or running deployment, so two builds of the same app never overlap. */
async function waitIdle(ctx, app) {
  const deadline = ctx.d.now() + ctx.config.idleTimeoutMs;
  let announced = false;
  for (;;) {
    const active = activeFor(await coolify(ctx, '/deployments'), app.uuid);
    if (!active.length) return;
    if (!announced) {
      ctx.d.log(`${app.name}: another deployment is already ${active[0].status}; waiting for it to finish first.`);
      announced = true;
    }
    if (ctx.d.now() >= deadline) throw new DeployError('busy', `${app.name} still has a running deployment after ${Math.round(ctx.config.idleTimeoutMs / 60_000)} minutes.`);
    await ctx.d.sleep(ctx.config.pollMs);
  }
}

/** Follows one deployment to a terminal state. A few failed polls in a row are tolerated (a build briefly starves the server); a long silence is not. */
async function followDeployment(ctx, app, deploymentUuid) {
  const deadline = ctx.d.now() + ctx.config.deployTimeoutMs;
  let misses = 0;
  let last = 'queued';
  for (;;) {
    try {
      const row = await coolify(ctx, `/deployments/${deploymentUuid}`);
      misses = 0;
      const state = deploymentState(row?.status);
      if (state !== last) ctx.d.log(`${app.name}: deployment is ${state}.`);
      last = state;
      if (TERMINAL.has(state)) return { state, commit: [row?.commit, row?.git_commit_sha].map((c) => String(c ?? '').trim().toLowerCase()).find((c) => SHA.test(c)) ?? null };
    } catch (error) {
      if (error.code === 'auth') throw error;
      misses += 1;
      if (misses >= 4) throw new DeployError('lost', `${app.name}: Coolify stopped answering while the deployment was running (${error.message}).`);
    }
    if (ctx.d.now() >= deadline) return { state: 'timeout', commit: null };
    await ctx.d.sleep(ctx.config.pollMs);
  }
}

/** A finished build is not a working site: probe every https domain until all answer 2xx/3xx or the time is up. */
async function checkHealth(ctx, app) {
  const detail = await coolify(ctx, `/applications/${app.uuid}`);
  const urls = publicUrls(detail?.fqdn, detail?.health_check_path);
  if (!urls.length) return { urls: [], note: 'no https domain configured, site probe skipped' };
  const deadline = ctx.d.now() + ctx.config.healthTimeoutMs;
  for (;;) {
    const statuses = [];
    for (const url of urls) statuses.push({ url, status: await ctx.d.probe(url) });
    if (statuses.every((s) => typeof s.status === 'number' && s.status >= 200 && s.status < 400)) return { urls: statuses };
    if (ctx.d.now() >= deadline) {
      const bad = statuses.filter((s) => !(typeof s.status === 'number' && s.status >= 200 && s.status < 400));
      throw new DeployError('health', `${app.name}: the site did not come up: ${bad.map((s) => `${safe(s.url, 80)} -> ${s.status}`).join(', ')}.`);
    }
    await ctx.d.sleep(Math.min(ctx.config.pollMs, 5_000));
  }
}

/**
 * The whole run. Returns { ok, skipped?, reason?, results[], failed?, notDeployed[] }; never throws for an expected failure.
 * `dryRun` does everything except POST /start: it reads, checks idleness and probes, so the real API shapes can be verified without deploying.
 */
export async function run(config, deps = {}) {
  const d = { ...realDeps(), ...deps };
  const ctx = { config, d };
  const results = [];
  try {
    await coolify(ctx, '/version'); // reachability and token, before anything else
    if (config.expectedSha) {
      const head = await d.branchHead(config.repo, config.branch);
      if (head !== config.expectedSha) {
        return { ok: true, skipped: true, results, notDeployed: config.apps.map((a) => a.name),
          reason: `${config.branch} is now at ${head.slice(0, 7)} but CI tested ${config.expectedSha.slice(0, 7)}. The newer commit gets its own CI and CD run, so nothing was deployed here.` };
      }
    }
    for (const app of config.apps) {
      const result = { name: app.name, uuid: app.uuid, deployment: null, commit: null, state: 'pending', health: [], warnings: [] };
      results.push(result);
      try {
        await waitIdle(ctx, app);
        if (config.dryRun) {
          const health = await checkHealth({ ...ctx, config: { ...config, healthTimeoutMs: 1 } }, app).catch((e) => ({ urls: [], note: e.message }));
          Object.assign(result, { state: 'dry run (nothing deployed)', health: health.urls, note: health.note });
          continue;
        }
        const started = await coolify(ctx, `/applications/${app.uuid}/start`, { method: 'POST' });
        const deployment = String(started?.deployment_uuid ?? '');
        if (!UUID.test(deployment)) throw new DeployError('no_deployment', `${app.name}: Coolify accepted the request but returned no deployment id.`);
        result.deployment = deployment;
        d.log(`${app.name}: deployment ${deployment} queued.`);
        const outcome = await followDeployment(ctx, app, deployment);
        result.commit = outcome.commit;
        if (outcome.state !== 'succeeded') throw new DeployError(outcome.state, `${app.name}: the deployment ${outcome.state === 'timeout' ? 'did not finish in time (it may still be running; check Coolify before retrying)' : outcome.state}.`);
        if (outcome.commit && outcome.commit !== config.expectedSha) result.warnings.push(`deployed ${outcome.commit.slice(0, 7)}, CI tested ${config.expectedSha.slice(0, 7)} (the branch moved during the deploy; the newer commit has its own run)`);
        if (!outcome.commit) result.warnings.push('Coolify did not report which commit was built');
        const health = await checkHealth(ctx, app);
        result.health = health.urls;
        if (health.note) result.warnings.push(health.note);
        result.state = 'deployed';
      } catch (error) {
        result.state = 'failed';
        result.error = safe(error?.message ?? error);
        const index = config.apps.findIndex((a) => a.uuid === app.uuid);
        return { ok: false, results, failed: app.name, code: error?.code ?? 'error', notDeployed: config.apps.slice(index + 1).map((a) => a.name) };
      }
    }
    return { ok: true, results, notDeployed: [] };
  } catch (error) {
    return { ok: false, results, failed: '(before any deploy)', code: error?.code ?? 'error', error: safe(error?.message ?? error), notDeployed: config.apps.map((a) => a.name) };
  }
}

/** Markdown for the run's summary page. */
export function summaryOf(config, outcome) {
  const lines = [`### Coolify deploy${config.dryRun ? ' (dry run)' : ''}`, ''];
  if (outcome.skipped) lines.push(`Skipped: ${outcome.reason}`);
  else {
    lines.push('| App | Result | Commit | Site |', '|---|---|---|---|');
    for (const r of outcome.results) {
      const site = r.health?.length ? r.health.map((h) => h.status).join(', ') : r.note || '-';
      lines.push(`| ${r.name} | ${r.state}${r.error ? `: ${r.error}` : ''} | ${r.commit ? r.commit.slice(0, 7) : '-'} | ${site} |`);
    }
    for (const r of outcome.results) for (const w of r.warnings ?? []) lines.push('', `- ${r.name}: ${w}`);
    if (!outcome.ok) {
      lines.push('', `**Failed at ${outcome.failed}.** ${outcome.notDeployed.length ? `Not deployed: ${outcome.notDeployed.join(', ')}. ` : ''}`
        + 'There is no automatic rollback: revert the commit on the default branch (CI then CD run again) or redeploy from Coolify.');
    }
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  let config;
  try {
    config = parseConfig(process.env);
  } catch (error) {
    console.log(`::error::${safe(error.message)}`);
    process.exitCode = 1;
    return;
  }
  const outcome = await run(config);
  const summary = summaryOf(config, outcome);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (outcome.skipped) console.log(`::notice::${safe(outcome.reason, 400)}`);
  else if (!outcome.ok) console.log(`::error::Deploy failed at ${safe(outcome.failed)}: ${safe(outcome.error ?? outcome.results.at(-1)?.error ?? outcome.code)}`);
  for (const r of outcome.results) for (const w of r.warnings ?? []) console.log(`::warning::${safe(r.name, 60)}: ${safe(w, 300)}`);
  if (!outcome.ok) process.exitCode = 1;
}

// Run only when executed directly (the action), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
