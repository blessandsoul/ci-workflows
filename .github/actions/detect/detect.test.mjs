// Offline tests for detect.mjs: `node --test` (no dependencies). Fixtures mimic the real repo shapes in use, including real git history for the
// "what changed" rules.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { detect, findDockerfiles, imageTrigger, majorOf, MAX_DOCKERFILES, runLines, scriptsOf, summaryOf } from './detect.mjs';

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
// The create-tigra shape: dependencies first (their own layer), then the whole app folder.
const NODE_DF = 'FROM node:22-alpine AS deps\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nFROM node:22-alpine AS run\nRUN apk add --no-cache curl\nWORKDIR /app\nCOPY --from=deps /app/node_modules ./node_modules\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000 || exit 1\n';
const FLAT = { 'package.json': PKG(FULL), 'package-lock.json': '{}', Dockerfile: NODE_DF };
const TRENDING = {
  'package.json': PKG(FULL),
  'package-lock.json': '{}',
  Dockerfile: NODE_DF,
  'server/package.json': PKG({ ...FULL, 'prisma:migrate:deploy': 'prisma migrate deploy' }),
  'server/package-lock.json': '{}',
  'server/prisma/schema.prisma': 'datasource db { provider = "mysql" url = env("DATABASE_URL") }',
  'server/prisma/migrations/20260101_init/migration.sql': 'select 1;',
  'server/prisma/migrations/migration_lock.toml': 'provider = "mysql"',
  'server/Dockerfile': NODE_DF.replaceAll('3000', '8000'),
  'server/.env.example': 'DATABASE_URL=mysql://x\n',
};

test('flat Next.js site: one app, its checks, no database tier', () => {
  const plan = detect(repo(FLAT), { event: 'push', refName: 'main', defaultBranch: 'main' });
  assert.deepEqual(plan.apps.map((a) => a.name), ['root']);
  assert.equal(plan.apps[0].typecheck, 'typecheck');
  assert.equal(plan.apps[0].build, 'build');
  assert.equal(plan.runMigrations, false);
  assert.ok(plan.reasons.some((r) => r.startsWith('migrations: skipped, no Prisma')));
  assert.equal(plan.runDocker, true); // no base commit: the changed files are unknown, so the image is built
  assert.equal(plan.runDockerCheck, true);
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

test("Dockerfile problems are the docker-check job's to report, not the plan's (one place, one red job)", () => {
  const plan = detect(repo({ ...FLAT, Dockerfile: 'FROM localhost:5000/landing-deps:4c3aadd82edc AS deps\nFROM node:24-slim\n' }), {});
  assert.equal(plan.findings.length, 0);
  assert.equal(plan.runDockerCheck, true);
  assert.deepEqual(plan.dockerChecked, ['Dockerfile']);
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
  assert.equal(plan.dockerChecked.length, total, 'the cheap check still covers every Dockerfile');
});

test('a pull request that only touches source code does not wake the Docker or migration tiers', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'src/index.ts': 'export {}' });
  const plan = detect(root, { event: 'pull_request', refName: 'feature', defaultBranch: 'main', base, head });
  assert.equal(plan.runDocker, false);
  assert.equal(plan.runMigrations, false);
  assert.ok(plan.reasons.includes('docker: Dockerfile not built, nothing it is built from changed (docker-check still checked it)'));
  assert.equal(plan.runDockerCheck, true, 'the cheap Dockerfile check runs on every push');
});

test('a code-only push to the default branch builds no image and runs no migrations (deploys no longer wait for image builds)', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'src/index.ts': 'export {}', 'server/src/app.ts': 'export {}' });
  const plan = detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head });
  assert.deepEqual([plan.runDocker, plan.runMigrations, plan.runDockerCheck], [false, false, true]);
  assert.match(summaryOf(plan), /push to the default branch/);
});

test('only the image whose inputs changed is built: its Dockerfile, its .dockerignore or the dependency files it installs from', () => {
  const cases = {
    Dockerfile: ['Dockerfile'],
    '.dockerignore': ['Dockerfile'],
    'server/Dockerfile': ['server/Dockerfile'],
    'package-lock.json': ['Dockerfile'],
    'server/package.json': ['server/Dockerfile'],
    'server/.npmrc': ['server/Dockerfile'],
  };
  for (const [file, expected] of Object.entries(cases)) {
    const content = file.endsWith('.json') ? '{"changed":true}' : file.endsWith('Dockerfile') ? `${TRENDING[file]}# change\n` : 'x\n';
    const { root, base, head } = repoWithChange(TRENDING, { [file]: content });
    const plan = detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head });
    assert.deepEqual(plan.dockerfiles.map((d) => d.file), expected, `${file} should build ${expected.join(', ')}`);
  }
});

test('a Prisma change wakes the migration tier and the image that ships the schema, nothing else', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'server/prisma/schema.prisma': 'model A { id Int @id }' });
  const plan = detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head });
  assert.equal(plan.runMigrations, true);
  assert.deepEqual(plan.dockerfiles.map((d) => [d.file, d.why]), [['server/Dockerfile', 'its Prisma schema or migrations changed (server/prisma/schema.prisma)']]);
});

test('data and scripts that merely live under prisma/ wake neither the migrations nor an image (arki-magazine keeps editorial content there)', () => {
  const { root, base, head } = repoWithChange(TRENDING, { 'server/prisma/production-editorial/content/en.json': '{}', 'server/prisma/seed.ts': 'export {}' });
  const plan = detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head });
  assert.deepEqual([plan.runMigrations, plan.runDocker], [false, false]);
  const migration = repoWithChange(TRENDING, { 'server/prisma/migrations/20260102_more/migration.sql': 'select 2;' });
  assert.equal(detect(migration.root, { event: 'push', refName: 'main', defaultBranch: 'main', base: migration.base, head: migration.head }).runMigrations, true);
});

test('the build context of a root Dockerfile is "." even when the repo path is spelled differently (trailing slash, forward slashes)', () => {
  const root = repo(TRENDING);
  for (const spelling of [`${root}${path.sep}`, root.split(path.sep).join('/')]) {
    assert.deepEqual(detect(spelling, {}).dockerfiles.map((d) => [d.file, d.context]), [['Dockerfile', '.'], ['server/Dockerfile', 'server']], spelling);
  }
});

test("migrations also run when the Prisma app's dependencies change (a Prisma upgrade), not for another app's", () => {
  const server = repoWithChange(TRENDING, { 'server/package-lock.json': '{"changed":true}' });
  assert.equal(detect(server.root, { event: 'push', refName: 'main', defaultBranch: 'main', base: server.base, head: server.head }).runMigrations, true);
  const client = repoWithChange(TRENDING, { 'package-lock.json': '{"changed":true}' });
  const plan = detect(client.root, { event: 'push', refName: 'main', defaultBranch: 'main', base: client.base, head: client.head });
  assert.equal(plan.runMigrations, false);
  assert.ok(plan.reasons.includes('migrations: skipped, no change to the Prisma schema, migrations or dependencies in server'));
});

test('files a Dockerfile copies by name wake it (entrypoint scripts, vendored packages)', () => {
  const files = {
    ...TRENDING,
    'server/Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json package-lock.json ./\nCOPY vendor ./vendor\nRUN npm ci\nCOPY . .\nCOPY entrypoint.sh /app/\nHEALTHCHECK CMD true\n',
    'server/vendor/pkg/index.js': '',
    'server/entrypoint.sh': '#!/bin/sh\n',
  };
  for (const [file, expected] of [['server/entrypoint.sh', true], ['server/vendor/pkg/index.js', true], ['server/src/app.ts', false]]) {
    const { root, base, head } = repoWithChange(files, { [file]: 'changed\n' });
    const plan = detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head });
    assert.equal(plan.dockerfiles.some((d) => d.file === 'server/Dockerfile'), expected, file);
  }
});

test('code that no checks job compiles is verified by its image build: a non-npm service, or an npm app outside the usual folders', () => {
  // project-fire's shape: a Python runtime and a Node agent built from the repo root, next to a normal server app.
  const files = {
    'server/package.json': PKG(FULL),
    'server/package-lock.json': '{}',
    'server/src/prompts/core.md': 'prompt',
    'server/src/app.ts': 'export {}',
    'ai-runtime/Dockerfile': 'FROM python:3.12-slim\nRUN apt-get install -y curl\nCOPY ai-runtime/pyproject.toml ./\nCOPY ai-runtime/src ./src\nCOPY server/src/prompts/core.md ./core.md\nEXPOSE 8100\n',
    'ai-runtime/pyproject.toml': '',
    'ai-runtime/src/main.py': '',
    'agent/Dockerfile': 'FROM node:24-slim\nCOPY agent/package.json agent/package-lock.json ./\nRUN npm ci\nCOPY agent/src ./src\nRUN npm run build\nHEALTHCHECK CMD true\n',
    'agent/package.json': PKG(FULL),
    'agent/package-lock.json': '{}',
    'agent/src/server.ts': '',
    'tools/Dockerfile': 'FROM golang:1.23\nCOPY . .\nRUN go build\nHEALTHCHECK CMD true\n',
    'tools/main.go': '',
  };
  const built = (changes) => {
    const { root, base, head } = repoWithChange(files, changes);
    return detect(root, { event: 'push', refName: 'main', defaultBranch: 'main', base, head }).dockerfiles.map((d) => d.file);
  };
  assert.deepEqual(built({ 'ai-runtime/src/main.py': 'x = 1\n' }), ['ai-runtime/Dockerfile']);
  assert.deepEqual(built({ 'server/src/prompts/core.md': 'new prompt' }), ['ai-runtime/Dockerfile'], 'a file copied from another folder');
  assert.deepEqual(built({ 'server/src/app.ts': 'export const a = 1' }), [], 'server code is covered by the checks job');
  assert.deepEqual(built({ 'agent/src/server.ts': 'export {}\n' }), ['agent/Dockerfile'], 'agent/ is not a folder the checks job looks in');
  assert.deepEqual(built({ 'tools/main.go': 'package main\n' }), ['tools/Dockerfile']);
  const plan = detect(repo(files), {});
  assert.deepEqual(plan.dockerfiles.filter((d) => d.file !== 'tools/Dockerfile').map((d) => [d.file, d.context]), [['agent/Dockerfile', '.'], ['ai-runtime/Dockerfile', '.']], 'built from the repo root, where their COPY sources are');
  assert.match(runLines(plan).find((l) => l.startsWith('docker: run')), /ai-runtime\/Dockerfile from the repo root, started and probed/);
});

test('an image whose .env.example names a secret is built but not started; browser-visible NEXT_PUBLIC_ names do not count', () => {
  const agent = { ...FLAT, '.env.example': 'OPENAI_API_KEY_FILE=/run/secrets/openai_api_key\nAICHATS_INTERNAL_TOKEN_FILE=/run/secrets/internal_token\n' };
  const [built] = detect(repo(agent), {}).dockerfiles;
  assert.deepEqual([built.smoke, built.smokeNote], [false, 'start skipped: needs secrets (its .env.example names one)']);
  const client = { ...FLAT, '.env.example': 'NEXT_PUBLIC_API_BASE_URL=http://localhost:8000\nNEXT_PUBLIC_RECAPTCHA_SITE_KEY=x\nNEXT_PUBLIC_APP_NAME=x\n' };
  assert.equal(detect(repo(client), {}).dockerfiles[0].smoke, true);
});

test('imageTrigger in isolation: a dependency file in another folder of a root context does not count', () => {
  const d = { file: 'Dockerfile', context: '.', npmFolders: ['.'], sources: [{ path: 'package.json', glob: false }, { path: 'package-lock.json*', glob: true }], copiesWholeContext: true };
  assert.equal(imageTrigger(d, 'server/package.json', new Set(['.', 'server'])), '');
  assert.equal(imageTrigger(d, 'package-lock.json', new Set(['.'])), 'its dependencies changed');
  assert.equal(imageTrigger(d, 'src/page.tsx', new Set(['.'])), '');
  assert.equal(imageTrigger(d, 'src/page.tsx', new Set()), 'its build context changed and no app check covers that code', 'the app has no typecheck/build script');
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
  assert.equal(plan.runDockerCheck, true, 'skipping the build keeps the cheap check');
  assert.ok(plan.findings.some((f) => /"bogus" is not a known check/.test(f.message)));
  assert.equal(detect(repo(TRENDING), { skip: 'docker-check' }).runDockerCheck, false);
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
  assert.ok(lines.includes('docker-check: run (Dockerfile, server/Dockerfile: static rules and lockfile, no build)'));
  assert.ok(lines.includes('docker: run (Dockerfile, started and probed: changed files unknown; server/Dockerfile, build only: changed files unknown)'));
  assert.ok(lines.includes('audit: run (advisory)') && lines.includes('secrets: run'));
  const quiet = detect(repo(FLAT), { event: 'pull_request', refName: 'f', defaultBranch: 'main', base: '0'.repeat(40), head: 'x', docker: 'never' });
  assert.ok(!runLines(quiet).some((l) => l.startsWith('docker:')), 'no build when the caller says never');
  assert.ok(runLines(quiet).some((l) => l.startsWith('docker-check: run')), 'the static check still runs');
  assert.match(summaryOf(quiet), /docker: skipped, turned off by the caller/);
  assert.match(summaryOf(plan), /\| root \| typecheck \| lint \| test \| build \|/);
});
