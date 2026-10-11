// Offline tests for dockerfile-check.mjs: `node --test` (no dependencies). The cases mirror the Python twin's tests (seed-plugins
// docker/test_dockerfile_check.py) so the two implementations stay interchangeable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { analyse, argNames, asText, check, classifyNpm, envPairs, findDockerfiles, Ignore, lockfileCheck, npmMajorFor, parse, printable, splitCopy, splitFrom } from './dockerfile-check.mjs';

/** Build a project folder from { 'relative/path': 'content' }. */
function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-dfc-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const rules = (findings) => findings.map((f) => `${f.level}:${f.rule}`).sort();
const staticFindings = (files, buildArgs = []) => check(repo(files), { buildArgs, lockfile: false }).findings;

const DF_OK = 'FROM node:22-alpine AS deps\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci\nFROM node:22-alpine AS run\nRUN apk add --no-cache curl\nCOPY --from=deps /app/node_modules ./node_modules\nHEALTHCHECK CMD curl -f http://localhost:3000 || exit 1\n';
const NODE_PROJECT = { Dockerfile: DF_OK, 'package.json': '{}', 'package-lock.json': '{}' };
const inClient = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [`client/${k}`, v]));

// npm 10's real output for arki-magazine's lockfile before its fix (commit aefe3b0^), trimmed to the part that matters.
const NPM10_SYNC = `npm error code EUSAGE
npm error
npm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before continuing.
npm error
npm error Missing: @emnapi/runtime@1.11.3 from lock file
npm error Missing: @emnapi/core@1.11.3 from lock file
npm error Missing: @emnapi/wasi-threads@1.2.3 from lock file
`;

/** Stands in for the npx launch: records every call and answers like npm would. */
function fakeNpm(code = 0, output = '') {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ args, cwd: options.cwd, listing: fs.readdirSync(options.cwd) });
    return { code, output };
  };
  return { run, calls };
}
const specOf = (args) => args.find((a) => a.startsWith('npm@'));
const prefixOf = (args) => args[args.indexOf('--prefix') + 1].replace(/\\/g, '/');

// ---------------------------------------------------------------- parsing

test('parse: continuations, comments inside them, keyword case and start lines', () => {
  const { instructions, notes } = parse('from node:22 as base\n# note\nRUN a \\\n  # comment inside\n  && b \\\n\n  && c\nCOPY x y\n');
  assert.deepEqual(instructions.map((i) => [i.keyword, i.line]), [['FROM', 1], ['RUN', 3], ['COPY', 8]]);
  assert.deepEqual(instructions[1].args.split(/\s+/), ['a', '&&', 'b', '&&', 'c']);
  assert.deepEqual(notes, []);
});

test('parse: a heredoc body is skipped and flagged; a non-default escape directive is unsupported', () => {
  assert.deepEqual(parse('RUN <<EOF\nnpm ci\nnpm run build\nEOF\nHEALTHCHECK CMD true\n').instructions.map((i) => [i.keyword, i.heredoc]), [['RUN', true], ['HEALTHCHECK', false]]);
  const escaped = parse('# escape=`\nFROM scratch\n');
  assert.deepEqual(escaped.instructions, []);
  assert.match(escaped.notes[0], /escape/);
});

test('FROM, COPY, ARG and ENV forms', () => {
  assert.deepEqual(splitFrom('--platform=linux/amd64 node:22 AS deps'), ['node:22', 'deps']);
  assert.deepEqual(splitFrom('node:22'), ['node:22', null]);
  assert.deepEqual(splitCopy('--from=builder --chown=a:b /app/x ./y'), { flags: { from: 'builder', chown: 'a:b' }, words: ['/app/x', './y'] });
  assert.deepEqual(splitCopy('["a b", "c"]'), { flags: {}, words: ['a b', 'c'] });
  assert.equal(splitCopy('"quoted src" dest'), null);
  assert.equal(splitCopy('onlyone'), null);
  assert.deepEqual(argNames('A B=1'), [['A', false], ['B', true]]);
  assert.deepEqual(envPairs('A=$A B="x y"'), [['A', '$A'], ['B', '"x']]);
  assert.deepEqual(envPairs('KEY some value'), [['KEY', 'some value']]);
});

// ---------------------------------------------------------------- .dockerignore

test('.dockerignore: folder patterns, * vs **, last match wins, ! re-includes, ./ and comments', () => {
  const by = (patterns, p) => new Ignore(patterns).ignoredBy(p);
  assert.equal(by(['node_modules'], 'node_modules/x/y.js'), 'node_modules');
  assert.equal(by(['node_modules'], 'src/node_modules/x.js'), null);
  assert.equal(by(['**/node_modules'], 'src/node_modules/x.js'), '**/node_modules');
  assert.equal(by(['/dist/'], 'dist/a.js'), '/dist/');
  assert.equal(by(['*.md'], 'README.md'), '*.md');
  assert.equal(by(['*.md'], 'docs/README.md'), null);
  assert.equal(by(['**/*.md'], 'README.md'), '**/*.md');
  assert.equal(by(['?x'], 'ax'), '?x');
  assert.equal(by(['.env*', '!.env.example'], '.env.example'), null);
  assert.equal(by(['*', '!package.json'], 'src'), '*');
  assert.equal(by(['a', '!a', 'a'], 'a'), 'a');
  assert.equal(by(['# node_modules', '', '   '], 'node_modules'), null);
  assert.equal(by(['./build'], 'build/x'), './build');
});

test('.dockerignore: unsupported patterns are counted, and a negated one makes the answer unsure', () => {
  const plain = new Ignore(['[ab].txt', 'dist']);
  assert.deepEqual([plain.unsupported, plain.sure, plain.ignoredBy('dist')], [1, true, 'dist']);
  const unsure = new Ignore(['*', '![ab].txt']);
  assert.deepEqual([unsure.unsupported, unsure.sure], [1, false]);
});

// ---------------------------------------------------------------- FROM rules

test('machine-local registries are errors (a real failure when an app moved between servers)', () => {
  for (const image of ['localhost:5000/landing-deps:4c3a', '127.0.0.1:5000/x:1', 'registry.local/x:1', '10.0.0.5/x:1', '192.168.1.2:5000/x:1']) {
    assert.deepEqual(rules(staticFindings({ Dockerfile: `FROM ${image}\nHEALTHCHECK CMD true\n` })), ['error:from-local-registry'], image);
  }
});

test('public registries, digests, stage names, scratch and variables are fine; :latest, untagged and private registries warn', () => {
  assert.deepEqual(staticFindings({ Dockerfile: 'FROM node:20-alpine@sha256:abc AS build\nFROM build AS final\nFROM ghcr.io/org/base:1.2\nFROM scratch\nFROM node:${V}\nFROM $BASE\nHEALTHCHECK CMD true\n' }), []);
  assert.deepEqual(rules(staticFindings({ Dockerfile: 'FROM nginx\nFROM node:latest\nFROM registry.acme.io/x:1\nHEALTHCHECK CMD true\n' })), ['warn:from-nonpublic', 'warn:from-unpinned', 'warn:from-unpinned']);
});

test('Coolify health check: HEALTHCHECK, curl or wget is enough; none of them warns', () => {
  for (const [text, expected] of [['FROM node:22\n', ['warn:no-healthcheck']], ['FROM node:22\nHEALTHCHECK CMD true\n', []], ['FROM node:22\nRUN apk add curl\n', []], ['FROM node:22\nRUN wget -q x\n', []]]) {
    assert.deepEqual(rules(staticFindings({ Dockerfile: text })), expected, text);
  }
});

// ---------------------------------------------------------------- COPY sources

test('a missing COPY source is an error, with a hint when only the letter case differs', () => {
  const found = staticFindings({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY nothere.txt ./\nCOPY package.json ./\n', 'Package.json': '{}' });
  assert.deepEqual(rules(found), ['error:copy-source-missing', 'error:copy-source-missing']);
  assert.match(found[0].message, /nothere\.txt/);
  assert.match(found[1].message, /exists as "Package\.json".*letter case/);
});

test('globs, JSON form, URLs, variables, --from images and the whole context are accepted', () => {
  const text = 'FROM node:22\nHEALTHCHECK CMD true\nCOPY package.json package-lock.json* pnpm-lock.yaml* yarn.lock* ./\nCOPY . .\nCOPY ["src", "./src"]\nADD https://example.com/x.tgz /x\nCOPY $FILE /x\nCOPY --from=nginx:alpine /a /b\nCOPY src/ ./\n';
  assert.deepEqual(staticFindings({ Dockerfile: text, 'package.json': '{}', 'package-lock.json': '{}', 'src/index.js': '' }), []);
});

test('a wildcard matching nothing only warns, and only when the whole COPY matched nothing; ../ is outside the context', () => {
  const found = staticFindings({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY lock-*.json ./\nCOPY package.json lock-*.json ./\n', 'package.json': '{}' });
  assert.deepEqual([rules(found), found[0].line], [['warn:copy-source-missing'], 3]);
  const outside = staticFindings({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY ../shared /x\n' });
  assert.match(outside[0].message, /outside the build context/);
});

test('.dockerignore hiding a COPY source is an error; a re-include or a Dockerfile-specific ignore file is respected', () => {
  const hidden = staticFindings({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY package.json package-lock.json ./\nCOPY src ./src\n', 'package.json': '{}', 'package-lock.json': '{}', 'src/a.js': '', '.dockerignore': 'package-lock.json\n' });
  assert.deepEqual(rules(hidden), ['error:copy-source-ignored']);
  const base = { Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY package*.json ./\n', 'package.json': '{}', 'package-lock.json': '{}' };
  assert.deepEqual(staticFindings({ ...base, '.dockerignore': '*.json\n!package.json\n' }), []);
  assert.deepEqual(rules(staticFindings({ ...base, '.dockerignore': '*.json\n' })), ['error:copy-source-ignored']);
  assert.deepEqual(staticFindings({ ...base, '.dockerignore': '*.json\n', 'Dockerfile.dockerignore': '# nothing excluded\n' }), []);
});

test('an unsure ignore file stays silent and says so; heredoc COPY and quoted words are noted, not judged', () => {
  const unsure = check(repo({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY package.json ./\n', 'package.json': '{}', '.dockerignore': '*\n![p]ackage.json\n' }), { lockfile: false });
  assert.deepEqual(unsure.findings, []);
  assert.ok(unsure.notes.some((n) => n.includes('copy-source-ignored was skipped')));
  const odd = check(repo({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nCOPY <<EOF /x\nhello\nEOF\nCOPY "a b" /x\n' }), { lockfile: false });
  assert.deepEqual([odd.findings, odd.notes.length], [[], 2]);
});

// ---------------------------------------------------------------- COPY --from

test('COPY --from: earlier stages, indexes, images and variables are fine; forward, self and out-of-range references are errors', () => {
  const f = (text) => rules(staticFindings({ Dockerfile: `HEALTHCHECK CMD true\n${text}` }));
  assert.deepEqual(f('FROM node:22 AS Deps\nFROM node:22 AS build\nCOPY --from=deps /a /a\nCOPY --from=0 /a /a\nCOPY --from=nginx:alpine /a /a\nCOPY --from=ghcr.io/x/y /a /a\nCOPY --from=$STAGE /a /a\n'), []);
  assert.deepEqual(f('FROM node:22 AS a\nCOPY --from=b /x /x\nFROM node:22 AS b\n'), ['error:copy-from-unknown']);
  assert.deepEqual(f('FROM node:22 AS a\nCOPY --from=a /x /x\n'), ['error:copy-from-unknown']);
  assert.deepEqual(f('FROM node:22\nCOPY --from=0 /x /x\n'), ['error:copy-from-unknown']);
  assert.deepEqual(f('FROM node:22\nFROM node:22\nCOPY --from=5 /x /x\n'), ['error:copy-from-unknown']);
  assert.deepEqual(f('FROM node:22 AS builder\nFROM node:22\nCOPY --from=biulder /x /x\n'), ['warn:copy-from-unknown']); // may be an image name
});

// ---------------------------------------------------------------- npm ci and ARGs

test('npm ci needs a lockfile (or a shrinkwrap); npm install does not', () => {
  assert.ok(rules(staticFindings({ Dockerfile: DF_OK, 'package.json': '{}' })).includes('error:npm-ci-without-lockfile'));
  assert.deepEqual(staticFindings({ Dockerfile: DF_OK.replace('package-lock.json', 'npm-shrinkwrap.json'), 'package.json': '{}', 'npm-shrinkwrap.json': '{}' }), []);
  assert.deepEqual(staticFindings({ Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nRUN npm install\n' }), []);
});

const ARG_DF = 'FROM node:22 AS builder\nARG NEXT_PUBLIC_API_BASE_URL\nENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL\n';

test('an ARG without a default copied into ENV warns (the arki-magazine build failure), unless the build passes it', () => {
  const found = staticFindings({ Dockerfile: `HEALTHCHECK CMD true\n${ARG_DF}` });
  assert.deepEqual([rules(found), found[0].line, found[0].names], [['warn:arg-empty-by-default'], 4, ['NEXT_PUBLIC_API_BASE_URL']]);
  assert.match(found[0].message, /ARG NEXT_PUBLIC_API_BASE_URL has no default/);
  assert.deepEqual(staticFindings({ Dockerfile: `HEALTHCHECK CMD true\n${ARG_DF}` }, ['NEXT_PUBLIC_API_BASE_URL=http://x']), []);
  for (const variant of ['ARG X=http://localhost\nENV X=$X\n', 'ARG X\nENV X=${X:-http://localhost}\n', 'ARG X\nENV Y=prefix-$X\n']) {
    assert.deepEqual(staticFindings({ Dockerfile: `HEALTHCHECK CMD true\nFROM node:22\n${variant}` }), [], variant);
  }
});

test('ARGs are scoped to their stage, and several empty ARGs become one finding', () => {
  assert.deepEqual(staticFindings({ Dockerfile: 'HEALTHCHECK CMD true\nARG GLOBAL\nFROM node:22 AS a\nARG X\nFROM node:22 AS b\nENV X=$X\nENV G=$GLOBAL\n' }), []);
  const found = staticFindings({ Dockerfile: 'HEALTHCHECK CMD true\nFROM node:22\nARG A\nARG B\nARG C=default\nENV A=$A\nENV B=${B}\nENV C=$C\n' });
  assert.deepEqual([rules(found), found[0].names, found[0].line], [['warn:arg-empty-by-default'], ['A', 'B'], 6]);
  assert.match(found[0].message, /ARG A, B have no default and are copied into ENV/);
});

// ---------------------------------------------------------------- discovery and build context

test('discovery: variants count; per-Dockerfile ignore files, copies of the project and deep folders do not', () => {
  const files = Object.fromEntries(['Dockerfile', 'Dockerfile.prod', 'client/Dockerfile', 'services/api/Dockerfile', 'a/b/c/Dockerfile', 'node_modules/x/Dockerfile', 'outputs/run/client/Dockerfile', 'docs/Dockerfile'].map((f) => [f, 'FROM scratch\n']));
  const root = repo({ ...files, 'Dockerfile.dockerignore': 'node_modules\n' });
  assert.deepEqual(findDockerfiles(root).map((f) => path.relative(root, f).split(path.sep).join('/')).sort(), ['Dockerfile', 'Dockerfile.prod', 'client/Dockerfile', 'services/api/Dockerfile']);
  const empty = check(repo({ 'README.md': 'x' }));
  assert.deepEqual([empty.errors, empty.dockerfiles], [0, []]);
  assert.ok(empty.notes.length);
});

test('a monorepo Dockerfile built from the repo root (project-fire ai-runtime) gets the root as its context, said so, and nothing missing', () => {
  const report = check(repo({ 'ai/Dockerfile': 'FROM python:3.12\nHEALTHCHECK CMD true\nCOPY ai/pyproject.toml ./\nCOPY shared/core.md ./core.md\n', 'ai/pyproject.toml': '', 'shared/core.md': '' }), { lockfile: false });
  assert.deepEqual([report.dockerfiles[0].context, report.dockerfiles[0].contextInferred, report.findings], ['.', true, []]);
  assert.ok(report.notes.some((n) => n.includes('build context taken to be .')));
  assert.match(asText(report), /context \., inferred/);
});

test('the own folder wins when it satisfies every source; otherwise errors are reported against it', () => {
  const own = check(repo({ 'client/Dockerfile': 'FROM node:22\nHEALTHCHECK CMD true\nCOPY package.json ./\n', 'client/package.json': '{}', 'package.json': '{}' }), { lockfile: false });
  assert.deepEqual([own.dockerfiles[0].context, own.dockerfiles[0].contextInferred], ['client', false]);
  const split = check(repo({ 'a/Dockerfile': 'FROM node:22\nHEALTHCHECK CMD true\nCOPY x ./\nCOPY y ./\n', 'a/x': '', y: '' }), { lockfile: false });
  assert.deepEqual([split.dockerfiles[0].context, split.findings.map((f) => f.message.split('"')[1])], ['a', ['y']]);
});

test('the Dockerfile-specific ignore file sits beside the Dockerfile; its patterns are relative to the context', () => {
  const base = { 'svc/Dockerfile': 'FROM node:22\nHEALTHCHECK CMD true\nCOPY svc/lib.js ./\n', 'svc/lib.js': '' };
  assert.deepEqual(rules(staticFindings({ ...base, 'svc/Dockerfile.dockerignore': 'svc/lib.js\n' })), ['error:copy-source-ignored']);
  assert.deepEqual(rules(staticFindings({ ...base, '.dockerignore': 'svc\n' })), ['error:copy-source-ignored']);
  assert.deepEqual(staticFindings({ ...base, '.dockerignore': 'svc\n', 'svc/Dockerfile.dockerignore': '# keep everything\n' }), []);
});

test('analyse reports what the Dockerfile copies by name, whether it copies the whole context, and where npm runs', () => {
  const root = repo({
    'server/Dockerfile': 'FROM node:24\nHEALTHCHECK CMD true\nCOPY package.json package-lock.json* ./\nCOPY vendor ./vendor\nRUN npm ci\nCOPY . .\nCOPY entrypoint.sh /app/\n',
    'server/package.json': '{}', 'server/package-lock.json': '{}', 'server/vendor/x.tgz': '', 'server/entrypoint.sh': '',
  });
  const a = analyse(root, path.join(root, 'server', 'Dockerfile'));
  assert.deepEqual(a.sources, [{ path: 'package.json', glob: false }, { path: 'package-lock.json*', glob: true }, { path: 'vendor', glob: false }, { path: 'entrypoint.sh', glob: false }]);
  assert.deepEqual([a.copiesWholeContext, a.usesNpm, a.npmFolders, a.lockfileFolders, a.port, a.nodeMajor], [true, true, ['server'], ['server'], '', 24]);
});

// ---------------------------------------------------------------- lockfile layer

test('which npm a node image bundles', () => {
  assert.deepEqual([null, 16, 18, 20, 22, 24, 25].map(npmMajorFor), [null, null, 10, 10, 10, 11, 11]);
});

test('npm results: the real npm 10 sync failure is an error naming the entries; network trouble is unverified; the rest warns', () => {
  const sync = classifyNpm(1, NPM10_SYNC, 10);
  assert.equal(sync.status, 'error');
  for (const name of ['@emnapi/runtime@1.11.3', '@emnapi/core@1.11.3', '@emnapi/wasi-threads@1.2.3', 'npm 10', 'npx npm@10 install']) assert.ok(sync.message.includes(name), name);
  assert.equal(classifyNpm(0, 'would add 5 packages', 10).status, 'ok');
  assert.equal(classifyNpm(1, 'npm error code ENOTFOUND\nnpm error network request failed', 10).status, 'unverified');
  assert.equal(classifyNpm(1, 'npm error fetch failed', 10).status, 'unverified');
  assert.equal(classifyNpm(1, 'npm error code E500\nnpm error something odd', 10).status, 'warn');
});

test("the image's npm checks the image's folder, from an empty scratch folder outside the project that is removed afterwards", () => {
  const fake = fakeNpm();
  const root = repo(inClient(NODE_PROJECT));
  const report = check(root, { run: fake.run });
  assert.equal(fake.calls.length, 1);
  const [{ args, cwd, listing }] = fake.calls;
  assert.equal(specOf(args), 'npm@10');
  assert.ok(prefixOf(args).endsWith('/client'));
  assert.deepEqual(args.slice(args.indexOf('ci')).filter((a, i, all) => a !== '--prefix' && all[i - 1] !== '--prefix'), ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.ok(path.relative(root, cwd).startsWith('..'), 'npx must not run inside the project (its .npmrc could redirect where npm comes from)');
  assert.deepEqual(listing, []);
  assert.equal(fs.existsSync(cwd), false);
  assert.deepEqual(report.lockfile.map((r) => r.status), ['ok']);
});

test('node:24 uses npm 11 and an explicit npm version wins', () => {
  const files = { ...NODE_PROJECT, Dockerfile: DF_OK.replaceAll('node:22', 'node:24') };
  let fake = fakeNpm();
  check(repo(files), { run: fake.run });
  assert.equal(specOf(fake.calls[0].args), 'npm@11');
  fake = fakeNpm();
  check(repo(files), { run: fake.run, npmVersion: 9 });
  assert.equal(specOf(fake.calls[0].args), 'npm@9');
});

test('a sync failure becomes an error finding on that lockfile', () => {
  const report = check(repo(inClient(NODE_PROJECT)), { run: fakeNpm(1, NPM10_SYNC).run });
  assert.deepEqual([report.errors, report.findings[0].rule, report.findings[0].file], [1, 'lockfile', 'client/package-lock.json']);
});

test('nothing to check means no npm call; a non-node base is skipped; one folder is checked once; --no-lockfile skips npm', () => {
  for (const files of [
    { Dockerfile: 'FROM node:22\nHEALTHCHECK CMD true\nRUN npm install\n', 'package.json': '{}', 'package-lock.json': '{}' },
    { Dockerfile: DF_OK, 'package.json': '{}' },
    { Dockerfile: DF_OK, 'package-lock.json': '{}' },
  ]) {
    const fake = fakeNpm();
    check(repo(files), { run: fake.run });
    assert.equal(fake.calls.length, 0);
  }
  const python = fakeNpm();
  const skipped = check(repo({ ...NODE_PROJECT, Dockerfile: DF_OK.replaceAll('node:22-alpine', 'python:3.12') }), { run: python.run });
  assert.deepEqual([python.calls.length, skipped.lockfile.map((r) => r.status)], [0, ['skipped']]);
  const twice = fakeNpm();
  check(repo({ ...NODE_PROJECT, 'Dockerfile.prod': DF_OK }), { run: twice.run });
  assert.equal(twice.calls.length, 1);
  const off = fakeNpm();
  check(repo(NODE_PROJECT), { run: off.run, lockfile: false });
  assert.equal(off.calls.length, 0);
});

test('npm runs in the app folder even when the context is the repo root (project-fire aichats-agent)', () => {
  const fake = fakeNpm();
  const app = { 'app/Dockerfile': 'FROM node:24\nHEALTHCHECK CMD true\nCOPY app/package.json app/package-lock.json ./\nRUN npm ci\n', 'app/package.json': '{}', 'app/package-lock.json': '{}' };
  const report = check(repo(app), { run: fake.run });
  assert.deepEqual([report.dockerfiles[0].context, specOf(fake.calls[0].args), report.lockfile.map((r) => [r.folder, r.status])], ['.', 'npm@11', [['app', 'ok']]]);
  assert.ok(prefixOf(fake.calls[0].args).endsWith('/app'));
  const noLock = { 'app/Dockerfile': app['app/Dockerfile'].replace(' app/package-lock.json', ''), 'app/package.json': '{}' };
  const missing = check(repo(noLock), { run: fakeNpm().run }).findings.filter((f) => f.rule === 'npm-ci-without-lockfile');
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /in app,/);
});

test('a failed or timed-out npx is unverified, never a failure', () => {
  const report = check(repo(NODE_PROJECT), { run: () => ({ error: 'npx did not answer in time.' }) });
  assert.deepEqual([report.lockfile[0].status, report.errors], ['unverified', 0]);
  assert.equal(lockfileCheck(repo(NODE_PROJECT), '.', 10, () => ({ error: 'npx could not be started (ENOENT).' })).status, 'unverified');
});

test('text output never carries terminal escapes from a Dockerfile', () => {
  const report = check(repo({ Dockerfile: 'FROM localhost:5000/\x1b]0;pwned\x07x:1\nHEALTHCHECK CMD true\n' }), { lockfile: false });
  assert.ok(!asText(report).includes('\x1b'));
  assert.equal(printable('a\x1b[31mb\tc\n'), 'ab\tc\n');
});
