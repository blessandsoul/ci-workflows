// Decides which CI checks apply to the repository in the current directory, and why.
//
// This is the only "smart" part of the shared CI. The reusable workflow (../../workflows/ci.yml) asks it for a plan and then runs exactly that plan, so a
// repository never needs per-project CI configuration: a flat Next.js site, a client/ + server/ pair, and a Next client at the root with a server/ folder
// (the create-tigra shapes) all get the right checks automatically.
//
// Principles
//  * Never silently skip something that should run. If a check cannot run (for example no package-lock.json) the plan says so as a finding.
//  * Cheap checks run on every push; expensive ones run only when something they alone can verify changed, on EVERY branch including the default
//    one (projects push straight to main and CD waits for this CI, so "always on main" made every deploy wait for image builds):
//      - docker-check (seconds): every Dockerfile's static rules and lockfile, see ../dockerfile-check/dockerfile-check.mjs.
//      - docker (minutes): an image is built only when something it is built from, and nothing cheaper verifies, changed (imageTrigger below).
//      - migrations: only when the Prisma folder or the Prisma app's dependencies changed.
//    When the changed files cannot be known (first push, manual run, force-push over a missing commit) everything runs: never less, only more.
//  * No dependencies: plain Node, so it can be unit-tested offline with `node --test`.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { analyse, findDockerfiles as findDockerfilePaths, Ignore, IGNORED_DIRS } from '../dockerfile-check/dockerfile-check.mjs';

export { IGNORED_DIRS };
// More than this many images in one repo is almost certainly not "the app"; build the first ones and say what was left out.
export const MAX_DOCKERFILES = 8;
// Folders that can hold an npm app. '.' covers flat repos and "client at the root, server in /server".
const APP_DIR_CANDIDATES = ['.', 'client', 'server', 'web', 'api', 'frontend', 'backend'];
const SCRIPT_ALIASES = { typecheck: ['typecheck', 'type-check', 'check-types', 'tsc'], lint: ['lint'], test: ['test'], build: ['build'] };
const PLACEHOLDER_TEST = /no test specified/i; // the `npm init` default must not count as a test suite
// Dependency manifests: in a folder whose package files an image copies (where its `npm ci` runs), a change to one of these changes the image.
const DEPENDENCY_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', 'pnpm-lock.yaml', 'yarn.lock']);
// Prisma files that change the generated client or what `migrate deploy` applies, relative to the app folder. Not everything under prisma/: seed
// scripts and data kept there (arki-magazine's production-editorial content) are neither, and used to trigger builds and migrations for nothing.
const PRISMA_INPUT = /^(?:prisma\/(?:schema\.prisma|schema\/.+|migrations\/.+)|prisma\.config\.[cm]?[jt]s)$/;
export const CHECK_NAMES = ['typecheck', 'lint', 'test', 'build', 'migrations', 'docker', 'docker-check', 'audit', 'secrets'];

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

/** Dockerfiles in the repo root or up to two folders down (`Dockerfile`, `client/Dockerfile`, `services/api/Dockerfile`), each analysed. */
export function findDockerfiles(root) {
  return findDockerfilePaths(root).map((abs) => analyseDockerfile(root, abs)).sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * What the planner needs to know about one Dockerfile. The analysis is the docker-check job's own (one parser, one idea of the build context); its
 * findings are reported by that job, not here, so they appear once. The image is built from the same context the check uses: the Dockerfile's
 * folder, or the repo root for a monorepo Dockerfile whose COPY sources only exist there (project-fire's ai-runtime and aichats-agent).
 */
export function analyseDockerfile(root, abs) {
  const a = analyse(root, abs);
  return {
    file: a.file,
    context: a.context,
    contextInferred: a.contextInferred,
    name: a.file.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'root',
    port: a.port,
    text: a.text,
    sources: a.sources,
    copiesWholeContext: a.copiesWholeContext,
    npmFolders: a.npmFolders,
  };
}

/**
 * Why changed file `f` means image `d` must be rebuilt, or '' when it does not. A full build only runs for what nothing cheaper verifies: code
 * inside an npm app is compiled and tested by the checks job, and every Dockerfile is checked statically by docker-check, so a code-only push builds
 * nothing. `checkedDirs` are the app folders whose code the checks job compiles. Every rule errs towards building.
 */
export function imageTrigger(d, f, checkedDirs) {
  const ctx = d.context === '.' ? '' : `${d.context}/`;
  if (f === d.file || f === `${d.file}.dockerignore` || f === `${ctx}.dockerignore`) return 'its Dockerfile or .dockerignore changed';
  for (const dir of d.npmFolders) {
    const prefix = dir === '.' ? '' : `${dir}/`;
    if (f.startsWith(prefix) && DEPENDENCY_FILES.has(f.slice(prefix.length))) return 'its dependencies changed';
    if (f.startsWith(prefix) && PRISMA_INPUT.test(f.slice(prefix.length))) return 'its Prisma schema or migrations changed';
  }
  if (!f.startsWith(ctx)) return '';
  const rel = f.slice(ctx.length);
  // Files and folders the Dockerfile copies by name: start scripts, configs, vendored packages, or the whole code of a non-npm service.
  for (const s of d.sources) {
    const hit = s.glob ? !!Ignore.compile(s.path)?.test(rel) : rel === s.path || rel.startsWith(`${s.path}/`);
    if (hit) return 'a file it copies by name changed';
  }
  // `COPY . .` of code no checks job compiles (a Python or Go service): the image build is the only check that code gets.
  const covered = d.npmFolders.length > 0 && d.npmFolders.every((dir) => checkedDirs.has(dir));
  if (d.copiesWholeContext && !covered) return 'its build context changed and no app check covers that code';
  return '';
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
    findings.push({ level: 'warn', where: 'docker', message: `${allDockerfiles.length} Dockerfiles found; only the first ${MAX_DOCKERFILES} are ever built (docker-check still checks them all). Never built: ${allDockerfiles.slice(MAX_DOCKERFILES).map((d) => d.file).join(', ')}.` });
  }
  const changed = changedFiles(root, ctx.base, ctx.head);
  // Shown on the summary only. It no longer forces anything: the default branch gets the same change-based plan as every other branch.
  const isDefaultPush = ctx.event === 'push' && !!ctx.refName && ctx.refName === ctx.defaultBranch;
  const reasons = [];

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

  // Migrations tier: `prisma migrate deploy` and the drift check depend on the schema, the migrations and the Prisma version (the app's package files).
  const prismaApp = plannedApps.find((a) => a.prisma);
  const hasMigrations = !!prismaApp && exists(root, prismaApp.dir, 'prisma', 'migrations') && fs.readdirSync(path.join(root, prismaApp.dir, 'prisma', 'migrations')).some((n) => !n.startsWith('.') && n !== 'migration_lock.toml');
  const prismaPrefix = prismaApp && prismaApp.dir !== '.' ? `${prismaApp.dir}/` : '';
  const migrationInput = (f) => f.startsWith(prismaPrefix) && (PRISMA_INPUT.test(f.slice(prismaPrefix.length)) || ['package.json', 'package-lock.json'].includes(f.slice(prismaPrefix.length)));
  let runMigrations = false;
  if (!prismaApp) reasons.push('migrations: skipped, no Prisma schema found');
  else if (!hasMigrations) reasons.push('migrations: skipped, Prisma schema has no migrations folder');
  else if (skip.has('migrations') || ctx.migrations === 'never') reasons.push('migrations: skipped, turned off by the caller');
  else if (ctx.migrations === 'always' || changed === null || changed.some(migrationInput)) runMigrations = true;
  else reasons.push(`migrations: skipped, no change to the Prisma schema, migrations or dependencies in ${prismaApp.dir === '.' ? 'the repo root' : prismaApp.dir}`);

  // Docker check: every Dockerfile, every push. Cheap, so it is not capped like the builds are.
  let runDockerCheck = false;
  if (!allDockerfiles.length) reasons.push('docker-check: skipped, no Dockerfile found');
  else if (skip.has('docker-check')) reasons.push('docker-check: skipped, turned off by the caller');
  else runDockerCheck = true;

  // Docker builds: per image, only when something it is built from changed (see imageTrigger).
  const checkedDirs = new Set(plannedApps.filter((a) => a.typecheck || a.build).map((a) => a.dir));
  const toBuild = [];
  if (!dockerfiles.length) reasons.push('docker: skipped, no Dockerfile found');
  else if (skip.has('docker') || ctx.docker === 'never') reasons.push('docker: skipped, turned off by the caller');
  else {
    for (const d of dockerfiles) {
      let why = '';
      if (ctx.docker === 'always') why = 'docker: always';
      else if (changed === null) why = 'changed files unknown';
      else {
        for (const f of changed) {
          const reason = imageTrigger(d, f, checkedDirs);
          if (reason) {
            why = `${reason} (${f})`;
            break;
          }
        }
      }
      if (why) toBuild.push({ ...d, why });
      else reasons.push(`docker: ${d.file} not built, nothing it is built from changed (docker-check still checked it)`);
    }
  }
  const runDocker = toBuild.length > 0;

  // A container is only started when it can plausibly run with no configuration: no Prisma next to it, and an .env.example (if any) that names
  // neither a database nor a secret. An app that refuses to start without its secrets (project-fire's aichats-agent reads two key files at
  // startup) would otherwise fail the probe for a reason that is not a bug. Browser-visible NEXT_PUBLIC_* names never count as secrets. Both are
  // looked for beside the Dockerfile, which is the app's folder even when the build context is the repo root.
  const dockerPlan = toBuild.map((d) => {
    const appDir = path.posix.dirname(d.file);
    const hasPrisma = exists(root, appDir, 'prisma', 'schema.prisma');
    const envExample = ['.env.example', '.env.sample'].map((f) => path.join(root, appDir, f)).find((f) => fs.existsSync(f));
    const envText = envExample ? fs.readFileSync(envExample, 'utf8') : '';
    const wantsDb = /DATABASE_URL|MYSQL_|REDIS_URL/.test(envText);
    const wantsSecret = /^\s*(?!NEXT_PUBLIC_)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|_FILE)\s*=/m.test(envText);
    const smoke = !!d.port && !hasPrisma && !wantsDb && !wantsSecret;
    const { text, sources, copiesWholeContext, npmFolders, ...rest } = d;
    const smokeNote = smoke ? '' : !d.port ? 'start skipped: no EXPOSE found'
      : hasPrisma || wantsDb ? 'start skipped: needs a database (migrations tier covers it)' : 'start skipped: needs secrets (its .env.example names one)';
    return { ...rest, smoke, smokeNote };
  });

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
    dockerChecked: allDockerfiles.map((d) => d.file),
    runDockerCheck,
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
  if (plan.runDockerCheck) lines.push(`docker-check: run (${plan.dockerChecked.join(', ')}: static rules and lockfile, no build)`);
  if (plan.runDocker) lines.push(`docker: run (${plan.dockerfiles.map((d) => `${d.file}${d.context !== path.posix.dirname(d.file) ? ` from ${d.context === '.' ? 'the repo root' : d.context}` : ''}${d.smoke ? ', started and probed' : ', build only'}: ${d.why}`).join('; ')})`);
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
  setOutput('run_docker_check', plan.runDockerCheck ? 'true' : 'false');
  setOutput('run_docker', plan.runDocker ? 'true' : 'false');
  // Only the images to build, and only what a build job uses.
  setOutput('dockerfiles', plan.dockerfiles.map(({ file, context, name, port, smoke }) => ({ file, context, name, port, smoke })));
  setOutput('run_audit', plan.runAudit ? 'true' : 'false');
  setOutput('run_secrets', plan.runSecrets ? 'true' : 'false');
  setOutput('secrets_range', plan.secretsRange);
  setOutput('plan', plan);
  // Error-level findings (an app on an unsupported package manager) do not stop the other jobs from running, but the final `CI` job turns them into
  // a failure so they are never just a yellow annotation. Dockerfile errors are the docker-check job's, which fails by itself.
  setOutput('error_count', String(plan.findings.filter((f) => f.level === 'error').length));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryOf(plan));
  console.log(`apps: ${plan.apps.map((a) => a.name).join(', ') || 'none'} | node ${plan.node} | changed: ${plan.changed}`);
  for (const line of [...runLines(plan), ...plan.reasons]) console.log(`- ${line}`);
  for (const f of plan.findings) console.log(`${f.level === 'error' ? '::error::' : '::warning::'}${f.message}`);
}

// Run only when executed directly (the action), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
