// Decides which CI checks apply to the repository in the current directory, and why.
//
// This is the only "smart" part of the shared CI. The reusable workflow (../../workflows/ci.yml) asks it for a plan and then runs exactly that plan, so a
// repository never needs per-project CI configuration: a flat Next.js site, a client/ + server/ pair, and a Next client at the root with a server/ folder
// (the create-tigra shapes) all get the right checks automatically.
//
// Principles
//  * Never silently skip something that should run. If a check cannot run (for example no package-lock.json) the plan says so as a finding.
//  * Cheap checks always run; expensive ones (Docker build, migrations) run only when something they depend on changed, or on a push to the default branch.
//  * No dependencies: plain Node, so it can be unit-tested offline with `node --test`.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Never searched for Dockerfiles. Besides build output this includes folders that hold COPIES of the project (found in a real repo: outputs/<run>/client/Dockerfile
// snapshots), which would otherwise be built on every run for nothing.
export const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache',
  'outputs', 'output', 'docs', 'examples', 'archive', 'tmp', 'vendor', 'fixtures', '.claude', '.worktrees', 'worktrees',
]);
// More than this many images in one repo is almost certainly not "the app"; build the first ones and say what was left out.
export const MAX_DOCKERFILES = 8;
// Folders that can hold an npm app. '.' covers flat repos and "client at the root, server in /server".
const APP_DIR_CANDIDATES = ['.', 'client', 'server', 'web', 'api', 'frontend', 'backend'];
const SCRIPT_ALIASES = { typecheck: ['typecheck', 'type-check', 'check-types', 'tsc'], lint: ['lint'], test: ['test'], build: ['build'] };
const PLACEHOLDER_TEST = /no test specified/i; // the `npm init` default must not count as a test suite
// Changes that can alter how an image builds or how the database schema behaves: these wake up the Docker and migration tiers.
const DOCKER_TRIGGERS = /(^|\/)(Dockerfile[^/]*|\.dockerignore|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(^|\/)prisma\//;
const PRISMA_TRIGGERS = /(^|\/)prisma\//;
const PUBLIC_REGISTRIES = new Set(['docker.io', 'index.docker.io', 'ghcr.io', 'gcr.io', 'quay.io', 'public.ecr.aws', 'mcr.microsoft.com', 'registry.k8s.io']);
export const CHECK_NAMES = ['typecheck', 'lint', 'test', 'build', 'migrations', 'docker', 'audit', 'secrets'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(...parts) {
  return fs.existsSync(path.join(...parts));
}

/** Which of the four npm scripts an app really has (aliases accepted, the default placeholder test ignored). Returns the script NAME or ''. */
export function scriptsOf(pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  const found = {};
  for (const [check, aliases] of Object.entries(SCRIPT_ALIASES)) {
    const name = aliases.find((a) => typeof scripts[a] === 'string' && scripts[a].trim() && !(check === 'test' && PLACEHOLDER_TEST.test(scripts[a])));
    found[check] = name || '';
  }
  return found;
}

/** First two-digit number in a version or range: '>=20' -> '20', '^22.1.0' -> '22', '20.x' -> '20'. 'lts/*' is passed through for setup-node. */
export function majorOf(value) {
  if (!value) return '';
  if (/^lts\//i.test(String(value).trim())) return String(value).trim();
  const m = String(value).match(/(\d{2})/);
  return m ? m[1] : '';
}

/** Node version for setup-node: explicit input, then .nvmrc / .node-version, then engines.node, then a Dockerfile's `FROM node:NN`, then 22. */
export function nodeVersion(root, apps, dockerfiles, override) {
  if (override) return String(override);
  for (const f of ['.nvmrc', '.node-version']) {
    if (exists(root, f)) {
      const v = majorOf(fs.readFileSync(path.join(root, f), 'utf8').trim().replace(/^v/, ''));
      if (v) return v;
    }
  }
  for (const app of apps) {
    const v = majorOf(readJson(path.join(root, app.dir, 'package.json'))?.engines?.node);
    if (v) return v;
  }
  for (const d of dockerfiles) {
    const m = d.text.match(/^\s*FROM\s+(?:--platform=\S+\s+)?node:(\d{2})/im);
    if (m) return m[1];
  }
  return '22';
}

/** npm apps in the usual folders. A root package.json with none of the four scripts is treated as a workspace shell and ignored when other apps exist. */
export function findApps(root) {
  const apps = [];
  const findings = [];
  for (const dir of APP_DIR_CANDIDATES) {
    const pkgPath = path.join(root, dir, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg) continue;
    const scripts = scriptsOf(pkg);
    const hasAny = Object.values(scripts).some(Boolean);
    const npmLock = exists(root, dir, 'package-lock.json');
    const otherManager = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].find((f) => exists(root, dir, f));
    const name = dir === '.' ? 'root' : dir;
    if (otherManager && !npmLock) {
      findings.push({ level: 'error', where: name, message: `${name}: uses ${otherManager}, but this CI only supports npm (package-lock.json). It was not checked.` });
      continue;
    }
    apps.push({
      name,
      dir,
      lockfile: npmLock,
      prisma: exists(root, dir, 'prisma', 'schema.prisma'),
      ...scripts,
      hasAny,
    });
    if (!npmLock) findings.push({ level: 'warn', where: name, message: `${name}: no package-lock.json, installs are not reproducible (using npm install).` });
  }
  // A root package.json with none of the four scripts next to real apps is a monorepo shell, not an app.
  const kept = apps.length > 1 ? apps.filter((a) => a.hasAny || a.dir !== '.') : apps;
  return { apps: kept, findings };
}

/** Dockerfiles in the repo root or up to two folders down (`Dockerfile`, `client/Dockerfile`, `services/api/Dockerfile`), each with context, port and findings. */
export function findDockerfiles(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      // `Dockerfile`, `Dockerfile.prod`, ...; but not `Dockerfile.dockerignore`, which is BuildKit's per-Dockerfile ignore list, not a build recipe.
      } else if (/^Dockerfile(\..+)?$/.test(e.name) && !e.name.endsWith('.dockerignore')) {
        const abs = path.join(dir, e.name);
        out.push(analyseDockerfile(root, abs));
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export function analyseDockerfile(root, abs) {
  const text = fs.readFileSync(abs, 'utf8');
  const file = path.relative(root, abs).split(path.sep).join('/');
  const contextDir = path.dirname(file) === '.' ? '.' : path.dirname(file);
  const findings = [];
  const stages = new Set();
  for (const m of text.matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    const image = m[1];
    if (m[2]) stages.add(m[2].toLowerCase());
    if (stages.has(image.toLowerCase()) || image.includes('$') || image.toLowerCase() === 'scratch') continue;
    const first = image.split('/')[0];
    const hasHost = image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
    if (hasHost) {
      const host = first.split(':')[0].toLowerCase();
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(host) || host.endsWith('.local') || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
        findings.push({ level: 'error', where: file, message: `${file}: FROM ${image} uses a registry that only exists on one machine. The build fails everywhere else.` });
      } else if (!PUBLIC_REGISTRIES.has(host)) {
        findings.push({ level: 'warn', where: file, message: `${file}: FROM ${image} uses a non-public registry (${host}); make sure CI and the servers can reach it.` });
      }
    }
    const tag = image.includes('@') ? 'pinned' : image.split('/').pop().split(':')[1];
    if (!tag || tag === 'latest') findings.push({ level: 'warn', where: file, message: `${file}: FROM ${image} is not pinned to a version, builds can change without a commit.` });
  }
  const hasHealthcheck = /^\s*HEALTHCHECK\s/im.test(text);
  const hasHttpTool = /\b(curl|wget)\b/.test(text);
  if (!hasHealthcheck && !hasHttpTool) {
    findings.push({ level: 'warn', where: file, message: `${file}: no HEALTHCHECK and no curl/wget; Coolify's HTTP health check needs one of them inside the image.` });
  }
  const port = (text.match(/^\s*EXPOSE\s+(\d+)/im) || [])[1] || '';
  return { file, context: contextDir, name: file.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root', port, findings, text };
}

/**
 * Paths changed between two commits, or null when unknown (first push, shallow history, force-push over a commit that no longer exists): null means
 * "assume everything changed", the safe direction. The three-dot form diffs against the merge base, so a pull request is not charged for commits that
 * landed on the default branch after it was opened; for a normal push (base is an ancestor of head) it is identical to a plain diff.
 */
export function changedFiles(root, base, head) {
  if (!base || !head || /^0+$/.test(base)) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** The whole decision. `ctx` carries the GitHub event facts and the caller's inputs, so tests can drive it without a runner. */
export function detect(root, ctx = {}) {
  const skip = new Set(String(ctx.skip || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
  const unknownSkips = [...skip].filter((s) => !CHECK_NAMES.includes(s));
  const { apps, findings } = findApps(root);
  const allDockerfiles = findDockerfiles(root);
  const dockerfiles = allDockerfiles.slice(0, MAX_DOCKERFILES);
  if (allDockerfiles.length > MAX_DOCKERFILES) {
    findings.push({ level: 'warn', where: 'docker', message: `${allDockerfiles.length} Dockerfiles found; only the first ${MAX_DOCKERFILES} are built. Not built: ${allDockerfiles.slice(MAX_DOCKERFILES).map((d) => d.file).join(', ')}.` });
  }
  const changed = changedFiles(root, ctx.base, ctx.head);
  const isDefaultPush = ctx.event === 'push' && !!ctx.refName && ctx.refName === ctx.defaultBranch;
  const reasons = [];
  const wakes = (re) => changed === null || changed.some((f) => re.test(f));

  for (const s of unknownSkips) findings.push({ level: 'warn', where: 'inputs', message: `skip: "${s}" is not a known check (${CHECK_NAMES.join(', ')}).` });

  // Per-app checks: a skipped check is blanked so the workflow simply has nothing to run for it.
  const plannedApps = apps.map((a) => {
    const out = { ...a };
    for (const check of ['typecheck', 'lint', 'test', 'build']) {
      if (skip.has(check)) out[check] = '';
    }
    if (!out.hasAny) findings.push({ level: 'warn', where: a.name, message: `${a.name}: has none of typecheck/lint/test/build scripts, so only the install is verified.` });
    else {
      for (const check of ['typecheck', 'lint', 'test']) {
        if (!a[check] && !skip.has(check)) findings.push({ level: 'warn', where: a.name, message: `${a.name}: no ${check} script, nothing to run for ${check}.` });
      }
    }
    return out;
  });

  // Migrations tier
  const prismaApp = plannedApps.find((a) => a.prisma);
  const hasMigrations = !!prismaApp && exists(root, prismaApp.dir, 'prisma', 'migrations') && fs.readdirSync(path.join(root, prismaApp.dir, 'prisma', 'migrations')).some((n) => !n.startsWith('.') && n !== 'migration_lock.toml');
  let runMigrations = false;
  if (!prismaApp) reasons.push('migrations: skipped, no Prisma schema found');
  else if (!hasMigrations) reasons.push('migrations: skipped, Prisma schema has no migrations folder');
  else if (skip.has('migrations') || ctx.migrations === 'never') reasons.push('migrations: skipped, turned off by the caller');
  else if (ctx.migrations === 'always' || isDefaultPush || wakes(PRISMA_TRIGGERS)) runMigrations = true;
  else reasons.push('migrations: skipped, nothing under prisma/ changed (runs on pushes to the default branch)');

  // Docker tier
  let runDocker = false;
  if (!dockerfiles.length) reasons.push('docker: skipped, no Dockerfile found');
  else if (skip.has('docker') || ctx.docker === 'never') reasons.push('docker: skipped, turned off by the caller');
  else if (ctx.docker === 'always' || isDefaultPush || wakes(DOCKER_TRIGGERS)) runDocker = true;
  else reasons.push('docker: skipped, no Dockerfile or dependency change (runs on pushes to the default branch)');

  // A container is only started when it can plausibly run without a database: no Prisma next to it, no DATABASE_URL in its .env.example.
  const dockerPlan = dockerfiles.map((d) => {
    const ctxDir = d.context;
    const hasPrisma = exists(root, ctxDir, 'prisma', 'schema.prisma');
    const envExample = ['.env.example', '.env.sample'].map((f) => path.join(root, ctxDir, f)).find((f) => fs.existsSync(f));
    const wantsDb = envExample ? /DATABASE_URL|MYSQL_|REDIS_URL/.test(fs.readFileSync(envExample, 'utf8')) : false;
    const smoke = !!d.port && !hasPrisma && !wantsDb;
    const { text, ...rest } = d;
    return { ...rest, smoke, smokeNote: smoke ? '' : d.port ? 'start skipped: needs a database (migrations tier covers it)' : 'start skipped: no EXPOSE found' };
  });
  findings.push(...dockerPlan.flatMap((d) => d.findings));

  if (!plannedApps.length) findings.push({ level: 'warn', where: 'repo', message: 'No npm app found in ., client, server, web, api, frontend or backend, so there are no code checks to run.' });
  if (plannedApps.some((a) => !a.lockfile) && plannedApps.every((a) => !a.lockfile)) reasons.push('audit: skipped, no package-lock.json');

  const runAudit = !skip.has('audit') && plannedApps.some((a) => a.lockfile);
  const runSecrets = !skip.has('secrets');
  const range = ctx.base && ctx.head && !/^0+$/.test(ctx.base) ? `${ctx.base}..${ctx.head}` : '-n 20';
  const node = nodeVersion(root, plannedApps, dockerfiles, ctx.nodeVersion);

  return {
    apps: plannedApps,
    node,
    prismaDir: prismaApp ? prismaApp.dir : '',
    runMigrations,
    dockerfiles: dockerPlan,
    runDocker,
    runAudit,
    runSecrets,
    secretsRange: range,
    changed: changed === null ? 'unknown (treated as everything)' : `${changed.length} file(s)`,
    isDefaultPush,
    reasons,
    findings: findings.map(({ level, message }) => ({ level, message })),
  };
}

/** GitHub Actions: write multi-line-safe outputs. */
function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (file) fs.appendFileSync(file, `${name}<<__CI_EOF__\n${text}\n__CI_EOF__\n`);
  else console.log(`${name}=${text}`);
}

/** One line per optional tier that WILL run (the skipped ones are explained in plan.reasons). */
export function runLines(plan) {
  const lines = [];
  if (plan.runMigrations) lines.push(`migrations: run (Prisma in ${plan.prismaDir === '.' ? 'the repo root' : plan.prismaDir})`);
  if (plan.runDocker) lines.push(`docker: run (${plan.dockerfiles.map((d) => `${d.file}${d.smoke ? ', started and probed' : ', build only'}`).join('; ')})`);
  if (plan.runAudit) lines.push('audit: run (advisory)');
  if (plan.runSecrets) lines.push('secrets: run');
  return lines;
}

/** Markdown for the run's summary page: what will run and why, so nobody has to open the logs to learn why Docker was skipped. */
export function summaryOf(plan) {
  const lines = ['### CI plan', ''];
  lines.push(`Node ${plan.node} · changed: ${plan.changed}${plan.isDefaultPush ? ' · push to the default branch' : ''}`, '');
  if (plan.apps.length) {
    lines.push('| App | typecheck | lint | test | build |', '|---|---|---|---|---|');
    for (const a of plan.apps) lines.push(`| ${a.name} | ${a.typecheck || '·'} | ${a.lint || '·'} | ${a.test || '·'} | ${a.build || '·'} |`);
    lines.push('');
  }
  lines.push(...[...runLines(plan), ...plan.reasons].map((t) => `- ${t}`));
  if (plan.findings.length) lines.push('', '**Findings**', ...plan.findings.map((f) => `- ${f.level === 'error' ? '❌' : '⚠️'} ${f.message}`));
  return `${lines.join('\n')}\n`;
}

function main() {
  const env = process.env;
  const plan = detect(env.GITHUB_WORKSPACE || process.cwd(), {
    event: env.CI_EVENT,
    refName: env.CI_REF_NAME,
    defaultBranch: env.CI_DEFAULT_BRANCH,
    base: env.CI_BASE_SHA,
    head: env.CI_HEAD_SHA,
    nodeVersion: env.INPUT_NODE_VERSION,
    skip: env.INPUT_SKIP,
    docker: (env.INPUT_DOCKER || 'auto').toLowerCase(),
    migrations: (env.INPUT_MIGRATIONS || 'auto').toLowerCase(),
  });
  setOutput('has_apps', plan.apps.length > 0 ? 'true' : 'false');
  setOutput('apps', plan.apps);
  setOutput('node', plan.node);
  setOutput('run_migrations', plan.runMigrations ? 'true' : 'false');
  setOutput('prisma_dir', plan.prismaDir);
  setOutput('run_docker', plan.runDocker ? 'true' : 'false');
  // Findings are already reported once as annotations; the matrix only needs what a build job uses.
  setOutput('dockerfiles', plan.dockerfiles.map(({ findings, ...build }) => build));
  setOutput('run_audit', plan.runAudit ? 'true' : 'false');
  setOutput('run_secrets', plan.runSecrets ? 'true' : 'false');
  setOutput('secrets_range', plan.secretsRange);
  setOutput('plan', plan);
  // Error-level findings (a Dockerfile that can only build on one machine, an unsupported package manager) do not stop the other jobs from running,
  // but the final `CI` job turns them into a failure so they are never just a yellow annotation.
  setOutput('error_count', String(plan.findings.filter((f) => f.level === 'error').length));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryOf(plan));
  console.log(`apps: ${plan.apps.map((a) => a.name).join(', ') || 'none'} | node ${plan.node} | changed: ${plan.changed}`);
  for (const line of [...runLines(plan), ...plan.reasons]) console.log(`- ${line}`);
  for (const f of plan.findings) console.log(`${f.level === 'error' ? '::error::' : '::warning::'}${f.message}`);
}

// Run only when executed directly (the action), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
