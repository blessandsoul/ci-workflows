// Runs the bash of two workflow steps (schema drift check, npm audit) against stubbed `npx`/`npm`, so the part of the workflow that talks to a person
// (annotations, run summary, exit codes) is tested without a runner, a database or the network. The step's script is read out of ci.yml itself, so
// the test cannot drift from what actually runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKFLOW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml');
const haveBash = spawnSync('bash', ['-c', 'true']).status === 0;
const haveJq = haveBash && spawnSync('bash', ['-c', 'jq --version']).status === 0;

/** The `run: |` script of the step with this name: the lines indented deeper than the step, de-indented. */
function stepScript(name) {
  const lines = fs.readFileSync(WORKFLOW, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found in ci.yml`);
  const runAt = lines.findIndex((l, i) => i > start && l.trim() === 'run: |');
  const indent = lines[runAt].search(/\S/) + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) >= indent); i += 1) body.push(lines[i].slice(indent));
  return body.join('\n');
}

/** Run `script` in a scratch folder with a fake `tool` that prints `output` and exits with `code`. Returns exit status, stdout and the summary file. */
function runStep(script, { tool, output, code, env = {}, prismaVersion = '6.19.3' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-step-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(dir, 'stub-output.txt'), output);
  fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\ncat "$STUB_OUT"\nexit "$STUB_CODE"\n', { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'node_modules', 'prisma'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'prisma', 'package.json'), JSON.stringify({ version: prismaVersion }));
  fs.mkdirSync(path.join(dir, 'app'));
  const summary = path.join(dir, 'summary.md');
  const done = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STUB_OUT: path.join(dir, 'stub-output.txt'), STUB_CODE: String(code), GITHUB_STEP_SUMMARY: summary, DATABASE_URL: 'mysql://x', ...env },
  });
  return { status: done.status, out: done.stdout + done.stderr, summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '' };
}

const PRISMA_DRIFT = `warn The configuration property \`package.json#prisma\` is deprecated and will be removed in Prisma 7.
[*] Changed the \`article_faqs\` table
  [*] Altered column \`questionRu\` (default changed from \`None\` to \`Some(Value(String("")))\`)
  [*] Altered column \`answerEn\` (default changed from \`None\` to \`Some(Value(String("")))\`)
┌─────────────────────────────────────────────┐
│  Update available 6.19.3 -> 8.0.0-rc.21     │
└─────────────────────────────────────────────┘
`;

test('drift check: no differences passes quietly', { skip: !haveBash }, () => {
  const r = runStep(stepScript('schema drift check'), { tool: 'npx', output: 'No difference detected.\n', code: 0 });
  assert.equal(r.status, 0);
  assert.equal(r.summary, '');
});

test('drift check: real drift fails, names the changes on the summary and keeps the noise off it', { skip: !haveBash }, () => {
  const r = runStep(stepScript('schema drift check'), { tool: 'npx', output: PRISMA_DRIFT, code: 2 });
  assert.equal(r.status, 1);
  assert.match(r.out, /::error::prisma\/schema\.prisma does not match the migrations \(3 change lines, listed on the run summary\)/);
  assert.match(r.summary, /### Schema drift/);
  assert.match(r.summary, /\[\*\] Changed the `article_faqs` table/);
  assert.match(r.summary, /Altered column `answerEn`/);
  assert.doesNotMatch(r.summary, /Update available|deprecated/);
  assert.match(r.summary, /commit the new migration folder/);
});

test('drift check: a command that failed to run is not reported as drift', { skip: !haveBash }, () => {
  const r = runStep(stepScript('schema drift check'), { tool: 'npx', output: 'Error: P1001 Cannot reach database server\n', code: 1 });
  assert.equal(r.status, 1);
  assert.match(r.out, /::error::prisma migrate diff could not run \(exit 1\)/);
  assert.doesNotMatch(r.out, /does not match the migrations/);
  assert.equal(r.summary, '');
});

test('drift check: Prisma 7 is skipped with a warning instead of guessing flags', { skip: !haveBash }, () => {
  const r = runStep(stepScript('schema drift check'), { tool: 'npx', output: '', code: 1, prismaVersion: '7.1.0' });
  assert.equal(r.status, 0);
  assert.match(r.out, /::warning::Prisma 7 detected/);
});

test('audit: findings become a warning with npm\'s own count, a summary line and never a failure', { skip: !haveJq }, () => {
  const apps = JSON.stringify([{ dir: 'app', lockfile: true }, { dir: 'nolock', lockfile: false }]);
  const r = runStep(stepScript('npm audit (production dependencies)'), { tool: 'npm', output: 'next  <15.4.8\nSeverity: high\n\n7 vulnerabilities (1 low, 3 moderate, 3 high)\n', code: 1, env: { APPS: apps } });
  assert.equal(r.status, 0);
  assert.match(r.out, /::warning::npm audit in 'app': 7 vulnerabilities \(1 low, 3 moderate, 3 high\)/);
  assert.match(r.summary, /- \*\*app\*\*: 7 vulnerabilities/);
  assert.doesNotMatch(r.out, /nolock/);
});

// Regression: when every finding has the same severity npm prints "2 high severity vulnerabilities" (not "N vulnerabilities (...)"). That line was
// not recognised, so a real finding was reported as "could not finish (registry unreachable?)".
test('audit: the single-severity count line is reported as findings, not as a registry failure', { skip: !haveJq }, () => {
  const apps = JSON.stringify([{ dir: 'app', lockfile: true }]);
  const r = runStep(stepScript('npm audit (production dependencies)'), { tool: 'npm', output: 'sharp  <0.35.5\nSeverity: high\n\n2 high severity vulnerabilities\n\nTo address all issues, run:\n  npm audit fix\n', code: 1, env: { APPS: apps } });
  assert.equal(r.status, 0);
  assert.match(r.out, /::warning::npm audit in 'app': 2 high severity vulnerabilities/);
  assert.match(r.summary, /- \*\*app\*\*: 2 high severity vulnerabilities/);
  assert.doesNotMatch(r.out, /could not finish/);
});

test('audit: a clean app is listed as clean; a registry failure says it could not finish', { skip: !haveJq }, () => {
  const apps = JSON.stringify([{ dir: 'app', lockfile: true }]);
  const clean = runStep(stepScript('npm audit (production dependencies)'), { tool: 'npm', output: 'found 0 vulnerabilities\n', code: 0, env: { APPS: apps } });
  assert.equal(clean.status, 0);
  assert.match(clean.summary, /- \*\*app\*\*: no high or critical vulnerabilities/);
  assert.doesNotMatch(clean.out, /::warning::/);
  const down = runStep(stepScript('npm audit (production dependencies)'), { tool: 'npm', output: 'npm error code ENOTFOUND\n', code: 1, env: { APPS: apps } });
  assert.equal(down.status, 0);
  assert.match(down.out, /::warning::npm audit in 'app' could not finish/);
});
