// Offline tests for detect.mjs: `node --test` (no dependencies). Fixtures mimic the real repo shapes in use, including real git history for the
// "what changed" rules.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyseDockerfile, detect, findDockerfiles, majorOf, MAX_DOCKERFILES, runLines, scriptsOf, summaryOf } from './detect.mjs';

const PKG = (scripts = {}, extra = {}) => JSON.stringify({ name: 'x', scripts, ...extra });
const FULL = { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run', build: 'next build' };

/** Build a repo folder from { 'relative/path': 'content' }. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-detect-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repo with two commits so `base`/`head` are real; the second commit changes `changedFiles`. */
function repoWithChange(files, changedFiles) {
  const root = repo(files);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  for (const [rel, content] of Object.entries(changedFiles)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'head');
  return { root, base, head: git(root, 'rev-parse', 'HEAD') };
}

const DOCKER_OK = 'FROM node:22-alpine AS deps\nRUN apk add --no-cache curl\nFROM node:22-alpine AS run\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000 || exit 1\n';
const FLAT = { 'package.json': PKG(FULL), 'package-lock.json': '{}', Dockerfile: DOCKER_OK };
const TRENDING = {
  'package.json': PKG(FULL),
  'package-lock.json': '{}',
  Dockerfile: DOCKER_OK,
  'server/package.json': PKG({ ...FULL, 'prisma:migrate:deploy': 'prisma migrate deploy' }),
  'server/package-lock.json': '{}',
  'server/prisma/schema.prisma': 'datasource db { provider = "mysql" url = env("DATABASE_URL") }',
  'server/prisma/migrations/20260101_init/migration.sql': 'select 1;',
  'server/prisma/migrations/migration_lock.toml': 'provider = "mysql"',
  'server/Dockerfile': DOCKER_OK.replace('3000', '8000'),
  'server/.env.example': 'DATABASE_URL=mysql://x\n',
};

test('flat Next.js site: one app, its checks, no database tier', () => {
  const plan = detect(repo(FLAT), { event: 'push', refName: 'main', defaultBranch: 'main' });
  assert.deepEqual(plan.apps.map((a) => a.name), ['root']);
  assert.equal(plan.apps[0].typecheck, 'typecheck');
  assert.equal(plan.apps[0].build, 'build');
  assert.equal(plan.runMigrations, false);
  assert.ok(plan.reasons.some((r) => r.startsWith('migrations: skipped, no Prisma')));
  assert.equal(plan.runDocker, true); // a push to the default branch always checks the image
});

test('client at the root plus server/ with Prisma (the typical full-stack shape)', () => {
  const plan = detect(repo(TRENDING), { event: 'push', refName: 'main', defaultBranch: 'main' });
  assert.deepEqual(plan.apps.map((a) => a.name), ['root', 'server']);
  assert.equal(plan.prismaDir, 'server');
  assert.equal(plan.runMigrations, true);
  assert.deepEqual(plan.dockerfiles.map((d) => [d.file, d.context, d.port]), [['Dockerfile', '.', '3000'], ['server/Dockerfile', 'server', '8000']]);
  const [client, server] = plan.dockerfiles;
  assert.equal(client.smoke, true, 'a client image can be started and probed on its own');
  assert.equal(server.smoke, false, 'a server with Prisma needs a database, so it is built but not started');
});

test('client/ and server/ folders', () => {
  const plan = detect(repo({ 'client/package.json': PKG(FULL), 'client/package-lock.json': '{}', 'server/package.json': PKG(FULL), 'server/package-lock.json': '{}' }), {});
  assert.deepEqual(plan.apps.map((a) => a.name), ['client', 'server']);
});

test('a scriptless root package.json next to real apps is a workspace shell and is ignored', () => {
  const plan = detect(repo({ 'package.json': PKG({ postinstall: 'echo hi' }), 'package-lock.json': '{}', 'client/package.json': PKG(FULL), 'client/package-lock.json': '{}' }), {});
  assert.deepEqual(plan.apps.map((a) => a.name), ['client']);
});

test('no npm app at all is reported, not silently green', () => {
  const plan = detect(repo({ 'README.md': 'hi' }), {});
  assert.equal(plan.apps.length, 0);
  assert.ok(plan.findings.some((f) => /No npm app found/.test(f.message)));
});

test('the npm-init placeholder test script does not count as a test suite', () => {
  assert.equal(scriptsOf({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } }).test, '');
  assert.equal(scriptsOf({ scripts: { 'type-check': 'tsc' } }).typecheck, 'type-check');
});

test('pnpm or yarn repos are flagged as unsupported instead of failing mysteriously', () => {
  const plan = detect(repo({ 'package.json': PKG(FULL), 'pnpm-lock.yaml': '' }), {});
  assert.equal(plan.apps.length, 0);
  assert.ok(plan.findings.some((f) => f.level === 'error' && /pnpm-lock\.yaml/.test(f.message)));
});

test('missing lockfile: still checked, with a warning', () => {
  const plan = detect(repo({ 'package.json': PKG(FULL) }), {});
  assert.equal(plan.apps[0].lockfile, false);
  assert.ok(plan.findings.some((f) => /no package-lock\.json/.test(f.message)));
  assert.equal(plan.runAudit, false);
});

test('Dockerfile portability: a machine-local registry is an error (a real failure when moving an app between servers)', () => {
  const root = repo({ Dockerfile: 'FROM localhost:5000/landing-deps:4c3aadd82edc AS deps\nFROM node:24-slim\nHEALTHCHECK CMD true\n' });
  const d = analyseDockerfile(root, path.join(root, 'Dockerfile'));
  assert.ok(d.findings.some((f) => f.level === 'error' && /only exists on one machine/.test(f.message)));
});

test('Dockerfile: earlier stage names, public registries and pinned digests are not flagged; :latest is', () => {
  const root = repo({ Dockerfile: 'FROM node:20-alpine@sha256:abc AS build\nFROM build AS final\nFROM ghcr.io/org/base:1.2\nFROM nginx:latest\nHEALTHCHECK CMD true\n' });
  const f = analyseDockerfile(root, path.join(root, 'Dockerfile')).findings;
  assert.equal(f.filter((x) => x.level === 'error').length, 0);
  assert.equal(f.filter((x) => /not pinned/.test(x.message)).length, 1);
  assert.ok(!f.some((x) => /non-public registry/.test(x.message)));
});

test('Dockerfile without HEALTHCHECK or curl/wget is warned about (Coolify needs one)', () => {
  const root = repo({ Dockerfile: 'FROM node:22-alpine\nEXPOSE 3000\nCMD ["node","server.js"]\n' });
  assert.ok(analyseDockerfile(root, path.join(root, 'Dockerfile')).findings.some((x) => /HEALTHCHECK/.test(x.message)));
});

test('Dockerfile discovery: variants count, per-Dockerfile ignore files and node_modules do not', () => {
  const root = repo({
    Dockerfile: DOCKER_OK,
    'Dockerfile.prod': DOCKER_OK,
    'Dockerfile.dockerignore': 'node_modules\n', // found in a real repo: BuildKit's ignore list for Dockerfile, not a build recipe
    'agent/Dockerfile': DOCKER_OK,
    'node_modules/pkg/Dockerfile': DOCKER_OK,
  });
  assert.deepEqual(findDockerfiles(root).map((d) => d.file).sort(), ['Dockerfile', 'Dockerfile.prod', 'agent/Dockerfile']);
});

test('Dockerfile discovery skips folders that hold copies of the project, and stops two levels down', () => {
  const root = repo({
    'client/Dockerfile': DOCKER_OK,
    'services/api/Dockerfile': DOCKER_OK,
    'outputs/run-1/client/Dockerfile': DOCKER_OK, // a snapshot copy, found in a real repo
    'docs/example/Dockerfile': DOCKER_OK,
    'a/b/c/Dockerfile': DOCKER_OK, // too deep to be "the app"
  });
  assert.deepEqual(findDockerfiles(root).map((d) => d.file), ['client/Dockerfile', 'services/api/Dockerfile']);
});

test('too many Dockerfiles: the first ones are built and the rest are named in a warning, never skipped silently', () => {
  const files = { 'package.json': PKG(FULL), 'package-lock.json': '{}' };
  const total = MAX_DOCKERFILES + 2;
  for (let i = 0; i < total; i += 1) files[`svc${String(i).padStart(2, '0')}/Dockerfile`] = DOCKER_OK;
  const plan = detect(repo(files), { event: 'push', refName: 'main', defaultBranch: 'main' });
  assert.equal(plan.dockerfiles.length, MAX_DOCKERFILES);
  assert.ok(plan.findings.some((f) => f.message.includes(`${total} Dockerfiles found`) && f.message.includes('svc09/Dockerfile')));
});

test('a pull request that only touches source code does not wake the Docker or migration tiers', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'src/index.ts': 'export {}' });
  const plan = detect(root, { event: 'pull_request', refName: 'feature', defaultBranch: 'main', base, head });
  assert.equal(plan.runDocker, false);
  assert.equal(plan.runMigrations, false);
  assert.ok(plan.reasons.some((r) => r.startsWith('docker: skipped, no Dockerfile or dependency change')));
});

test('a Dockerfile or dependency change wakes the Docker tier', () => {
  for (const file of ['Dockerfile', 'server/Dockerfile', 'package-lock.json', 'server/package.json']) {
    const { root, base, head } = repoWithChange(TRENDING, { [file]: file.endsWith('.json') ? '{"changed":true}' : DOCKER_OK + '# change\n' });
    const plan = detect(root, { event: 'pull_request', refName: 'f', defaultBranch: 'main', base, head });
    assert.equal(plan.runDocker, true, `${file} should wake the Docker tier`);
  }
});

test('a Prisma change wakes the migration tier (and the Docker tier, since the start command migrates)', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'server/prisma/schema.prisma': 'model A { id Int @id }' });
  const plan = detect(root, { event: 'pull_request', refName: 'f', defaultBranch: 'main', base, head });
  assert.equal(plan.runMigrations, true);
  assert.equal(plan.runDocker, true);
});

test('a push to the default branch always runs the heavy tiers, even when nothing relevant changed', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'src/index.ts': 'export {}' });
  const plan = detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head });
  assert.equal(plan.runDocker, true);
  assert.equal(plan.runMigrations, true);
});

test('first push (all-zero base) is treated as "everything changed"', () => {
  const plan = detect(repo(TRENDING), { event: 'push', refName: 'dev', defaultBranch: 'main', base: '0'.repeat(40), head: 'abc' });
  assert.equal(plan.runDocker, true);
  assert.match(plan.changed, /unknown/);
  assert.equal(plan.secretsRange, '-n 20');
});

test('secret scan range is base..head when known', () => {
  const { root, base, head } = repoWithChange(FLAT, { 'a.txt': 'x' });
  assert.equal(detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head }).secretsRange, `${base}..${head}`);
});

test('node version: input, .nvmrc, engines, Dockerfile, default', () => {
  const run = (files, override) => detect(repo(files), { nodeVersion: override }).node;
  assert.equal(run({ ...FLAT }, '18'), '18');
  assert.equal(run({ ...FLAT, '.nvmrc': 'v20.11.0\n' }), '20');
  assert.equal(run({ 'package.json': PKG(FULL, { engines: { node: '>=24' } }), 'package-lock.json': '{}' }), '24');
  assert.equal(run({ ...FLAT, Dockerfile: 'FROM node:24-bookworm-slim\nHEALTHCHECK CMD true\n' }), '24');
  assert.equal(run({ 'package.json': PKG(FULL), 'package-lock.json': '{}' }), '22');
  assert.equal(majorOf('lts/*'), 'lts/*');
  assert.equal(majorOf('^22.1.0'), '22');
});

test('skip list blanks the named checks and unknown names are warned about', () => {
  const plan = detect(repo(TRENDING), { event: 'push', refName: 'main', defaultBranch: 'main', skip: 'test, docker, bogus' });
  assert.equal(plan.apps[0].test, '');
  assert.equal(plan.apps[0].lint, 'lint');
  assert.equal(plan.runDocker, false);
  assert.ok(plan.findings.some((f) => /"bogus" is not a known check/.test(f.message)));
});

test('docker and migrations can be forced with always / never', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'src/index.ts': 'export {}' });
  const ctx = { event: 'pull_request', refName: 'f', defaultBranch: 'main', base, head };
  assert.equal(detect(root, { ...ctx, docker: 'always', migrations: 'always' }).runDocker, true);
  assert.equal(detect(root, { ...ctx, docker: 'always', migrations: 'always' }).runMigrations, true);
  assert.equal(detect(root, { ...ctx, docker: 'never', migrations: 'never' }).runDocker, false);
});

test('a repo with Prisma but no migrations folder skips the migration tier with a reason', () => {
  const files = { ...TRENDING };
  delete files['server/prisma/migrations/20260101_init/migration.sql'];
  delete files['server/prisma/migrations/migration_lock.toml'];
  const plan = detect(repo(files), { event: 'push', refName: 'main', defaultBranch: 'main' });
  assert.equal(plan.runMigrations, false);
  assert.ok(plan.reasons.some((r) => /no migrations folder/.test(r)));
});

test('the plan says what will run, with what and why the rest was skipped (console lines and summary page)', () => {
  const plan = detect(repo(TRENDING), { event: 'push', refName: 'main', defaultBranch: 'main' });
  const lines = runLines(plan);
  assert.ok(lines.includes('migrations: run (Prisma in server)'));
  assert.ok(lines.some((l) => l.startsWith('docker: run (Dockerfile, started and probed; server/Dockerfile, build only)')));
  assert.ok(lines.includes('audit: run (advisory)') && lines.includes('secrets: run'));
  const quiet = detect(repo(FLAT), { event: 'pull_request', refName: 'f', defaultBranch: 'main', base: '0'.repeat(40), head: 'x', docker: 'never' });
  assert.ok(!runLines(quiet).some((l) => l.startsWith('docker')));
  assert.match(summaryOf(quiet), /docker: skipped, turned off by the caller/);
  assert.match(summaryOf(plan), /\| root \| typecheck \| lint \| test \| build \|/);
});
