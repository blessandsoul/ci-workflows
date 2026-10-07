// Runs deploy.mjs against a FAKE Coolify server (real HTTP, scripted behaviour) with a fake clock, so ordering, failures, timeouts and the
// "never deploy the wrong commit" rules are exercised offline and in milliseconds. `node --test`, no dependencies.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { activeFor, deploymentState, parseConfig, publicUrls, run, safe, summaryOf } from './deploy.mjs';

const TOKEN = 'SECRET-TOKEN-123';
const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SERVER = 'srvuuid000000000000000001';
const CLIENT = 'cliuuid000000000000000002';

/**
 * A scripted Coolify. `plan` per application uuid: { statuses: [...], commit, fqdn, healthPath, busy: n, startResponse }.
 *   statuses  what GET /deployments/{id} answers on successive polls (the last one repeats)
 *   busy      how many polls of GET /deployments still show this app as running before it goes idle
 *   failPolls how many deployment polls answer HTTP 500 first
 */
async function fakeCoolify(plan = {}, { versionStatus = 200, redirectVersion = '' } = {}) {
  const calls = [];
  const state = { n: 0, deployments: {}, busy: {} };
  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    calls.push(`${req.method} ${path}`);
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Unauthenticated.' });
    if (path === '/api/v1/version') {
      if (redirectVersion) { res.writeHead(302, { Location: redirectVersion }); return res.end(); }
      return versionStatus === 200 ? send(200, '4.0.0-beta.469') : send(versionStatus, { message: 'Missing required permissions: read' });
    }
    if (path === '/api/v1/deployments') {
      const rows = [];
      for (const [uuid, p] of Object.entries(plan)) {
        state.busy[uuid] ??= p.busy ?? 0;
        if (state.busy[uuid] > 0) { state.busy[uuid] -= 1; rows.push({ status: 'in_progress', deployment_url: `/project/x/environment/y/application/${uuid}/deployment/z` }); }
      }
      return send(200, rows);
    }
    let m = path.match(/^\/api\/v1\/applications\/([^/]+)\/start$/);
    if (m && req.method === 'POST') {
      const p = plan[m[1]];
      if (p?.startResponse) return send(p.startResponse.status ?? 200, p.startResponse.body ?? {});
      state.n += 1;
      const id = `dep${String(state.n).padStart(3, '0')}-${m[1].slice(0, 6)}`;
      state.deployments[id] = { polls: 0, uuid: m[1] };
      return send(200, { message: 'Deployment request queued.', deployment_uuid: id });
    }
    m = path.match(/^\/api\/v1\/deployments\/([^/]+)$/);
    if (m) {
      const d = state.deployments[m[1]];
      if (!d) return send(404, { message: 'Deployment not found.' });
      const p = plan[d.uuid] ?? {};
      if (d.polls < (p.failPolls ?? 0)) { d.polls += 1; return send(500, { message: 'boom' }); }
      const list = p.statuses ?? ['queued', 'in_progress', 'finished'];
      const status = list[Math.min(d.polls - (p.failPolls ?? 0), list.length - 1)];
      d.polls += 1;
      return send(200, { status, ...(status === 'finished' && p.commit !== null ? { commit: p.commit ?? SHA } : {}) });
    }
    m = path.match(/^\/api\/v1\/applications\/([^/]+)$/);
    if (m) {
      const p = plan[m[1]] ?? {};
      return send(200, { fqdn: p.fqdn ?? `https://${m[1].slice(0, 6)}.example.test`, health_check_path: p.healthPath ?? '/' });
    }
    return send(404, { message: 'nope' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, state, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }) };
}

/** Fake clock: sleeping just advances time, so "wait 15 minutes" costs nothing. */
function fakeEnv(overrides = {}) {
  let t = 0;
  const logs = [];
  const probes = overrides.probes ?? [];
  return {
    logs,
    deps: {
      sleep: async (ms) => { t += ms; },
      now: () => t,
      log: (line) => logs.push(line),
      branchHead: async () => SHA,
      probe: async () => (probes.length > 1 ? probes.shift() : probes[0] ?? 200),
      ...overrides.deps,
    },
  };
}

const config = (base, apps, extra = {}) => ({
  base, token: TOKEN, apps, expectedSha: SHA, repo: 'owner/repo', branch: 'main', dryRun: false,
  pollMs: 1000, deployTimeoutMs: 60_000, idleTimeoutMs: 20_000, healthTimeoutMs: 10_000, ...extra,
});
const one = [{ uuid: SERVER, name: 'server' }];
const two = [{ uuid: SERVER, name: 'server' }, { uuid: CLIENT, name: 'client' }];

test('helpers: status words, active deployments, probe URLs, safe text', () => {
  assert.deepEqual(['queued', 'in_progress', 'finished', 'failed', 'cancelled-by-user', 'weird', undefined].map(deploymentState),
    ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'unknown']);
  const rows = [{ status: 'in_progress', deployment_url: `/a/${SERVER}/d` }, { status: 'queued', deployment_url: `/a/${CLIENT}/d` }, { status: 'finished', deployment_url: `/a/${SERVER}/d` }];
  assert.equal(activeFor(rows, SERVER).length, 1);
  assert.equal(activeFor({ deployments: rows }, CLIENT).length, 1);
  assert.deepEqual(activeFor('garbage', SERVER), []);
  assert.deepEqual(publicUrls('https://a.test, http://plain.test, https://u:p@creds.test, https://q.test/?x=1, https://b.test/base/', '/health'), ['https://a.test/health', 'https://b.test/base/health']);
  assert.deepEqual(publicUrls('https://a.test', '//evil'), ['https://a.test/']);
  assert.deepEqual(publicUrls(null, null), []);
  assert.equal(safe('ok\x1b[2J\x1b]0;pwned\x07\r\nnext‮'), 'ok\nnext');
});

test('parseConfig: https only, token required, valid apps and commit, defaults', () => {
  const ok = { COOLIFY_URL: 'https://coolify.example.test/', COOLIFY_TOKEN: ` ${TOKEN} `, APPS: JSON.stringify(two), EXPECTED_SHA: SHA.toUpperCase(), GITHUB_REPOSITORY: 'owner/repo', BRANCH: 'main' };
  const parsed = parseConfig(ok);
  assert.equal(parsed.base, 'https://coolify.example.test');
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.expectedSha, SHA);
  assert.equal(parsed.deployTimeoutMs, 15 * 60_000);
  const bad = (patch, text) => assert.throws(() => parseConfig({ ...ok, ...patch }), (e) => e.code === 'config' && text.test(e.message), JSON.stringify(patch).slice(0, 60));
  bad({ COOLIFY_URL: 'http://coolify.example.test' }, /https/);
  bad({ COOLIFY_URL: 'https://u:p@coolify.example.test' }, /credentials/);
  bad({ COOLIFY_URL: 'nonsense' }, /valid URL/);
  bad({ COOLIFY_TOKEN: '  ' }, /secret is missing/);
  bad({ APPS: 'not json' }, /valid JSON/);
  bad({ APPS: '[]' }, /at least one/);
  bad({ APPS: JSON.stringify([{ uuid: '../etc' }]) }, /valid uuid/);
  bad({ EXPECTED_SHA: 'abc123' }, /40-character/);
  bad({ GITHUB_REPOSITORY: 'no-slash' }, /owner\/name/);
  bad({ BRANCH: 'a b' }, /branch/);
  assert.equal(parseConfig({ ...ok, EXPECTED_SHA: '', DRY_RUN: '1' }).dryRun, true); // a dry run may omit the commit
});

test('one app: start, follow to the end, probe the site, report the commit', async () => {
  const fake = await fakeCoolify({ [SERVER]: { fqdn: 'https://site.example.test', healthPath: '/api/v1/live' } });
  const probed = [];
  const env = fakeEnv({ deps: { probe: async (url) => { probed.push(url); return 200; } } });
  const out = await run(config(fake.url, one), env.deps);
  await fake.close();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(out.results.map((r) => [r.name, r.state, r.commit]), [['server', 'deployed', SHA]]);
  assert.deepEqual(probed, ['https://site.example.test/api/v1/live']);
  assert.deepEqual(fake.calls.filter((c) => c.startsWith('POST')), [`POST /api/v1/applications/${SERVER}/start`]);
  assert.equal(fake.calls[0], 'GET /api/v1/version');
});

test('two apps deploy in the given order, one after the other', async () => {
  const fake = await fakeCoolify();
  const out = await run(config(fake.url, two), fakeEnv().deps);
  await fake.close();
  assert.equal(out.ok, true);
  const order = fake.calls.filter((c) => c.startsWith('POST'));
  assert.deepEqual(order, [`POST /api/v1/applications/${SERVER}/start`, `POST /api/v1/applications/${CLIENT}/start`]);
  // the server's deployment was followed to the end BEFORE the client was started
  const lastServerPoll = fake.calls.findLastIndex((c) => c.startsWith('GET /api/v1/deployments/dep001'));
  assert.ok(lastServerPoll < fake.calls.indexOf(order[1]));
});

test('a failed server deployment stops the run: the client is never started', async () => {
  const fake = await fakeCoolify({ [SERVER]: { statuses: ['in_progress', 'failed'] } });
  const out = await run(config(fake.url, two), fakeEnv().deps);
  await fake.close();
  assert.equal(out.ok, false);
  assert.equal(out.failed, 'server');
  assert.equal(out.code, 'failed');
  assert.deepEqual(out.notDeployed, ['client']);
  assert.ok(!fake.calls.includes(`POST /api/v1/applications/${CLIENT}/start`));
  assert.match(summaryOf(config(fake.url, two), out), /Not deployed: client[\s\S]*no automatic rollback/);
});

test('cancelled and timed-out deployments are failures, a timeout says it may still be running', async () => {
  let fake = await fakeCoolify({ [SERVER]: { statuses: ['cancelled'] } });
  let out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'cancelled']);
  fake = await fakeCoolify({ [SERVER]: { statuses: ['in_progress'] } });
  out = await run(config(fake.url, one, { deployTimeoutMs: 30_000 }), fakeEnv().deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'timeout']);
  assert.match(out.results[0].error, /may still be running/);
});

test('an app that already has a deployment running is waited for, then deployed once', async () => {
  const fake = await fakeCoolify({ [SERVER]: { busy: 3 } });
  const env = fakeEnv();
  const out = await run(config(fake.url, one), env.deps);
  await fake.close();
  assert.equal(out.ok, true);
  assert.ok(env.logs.some((l) => /already in_progress; waiting/.test(l)));
  assert.equal(fake.calls.filter((c) => c.startsWith('POST')).length, 1);
  const forever = await fakeCoolify({ [SERVER]: { busy: 10_000 } });
  const stuck = await run(config(forever.url, one, { idleTimeoutMs: 5_000 }), fakeEnv().deps);
  await forever.close();
  assert.deepEqual([stuck.ok, stuck.code], [false, 'busy']);
  assert.ok(!forever.calls.some((c) => c.startsWith('POST')));
});

test('if the branch moved on after CI, nothing is deployed and the run is not a failure', async () => {
  const fake = await fakeCoolify();
  const out = await run(config(fake.url, two), fakeEnv({ deps: { branchHead: async () => OTHER } }).deps);
  await fake.close();
  assert.deepEqual([out.ok, out.skipped], [true, true]);
  assert.match(out.reason, /bbbbbbb but CI tested aaaaaaa/);
  assert.ok(!fake.calls.some((c) => c.startsWith('POST')));
});

test('if the branch head cannot be read, nothing is deployed (not knowing means not deploying)', async () => {
  const fake = await fakeCoolify();
  const out = await run(config(fake.url, one), fakeEnv({ deps: { branchHead: async () => { throw Object.assign(new Error('GitHub answered 502'), { code: 'head_unreadable' }); } } }).deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'head_unreadable']);
  assert.ok(!fake.calls.some((c) => c.startsWith('POST')));
});

test('a refused token fails before anything else, and the token is never printed anywhere', async () => {
  const fake = await fakeCoolify({}, { versionStatus: 403 });
  const env = fakeEnv();
  const out = await run(config(fake.url, one), env.deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'auth']);
  assert.ok(!fake.calls.some((c) => c.startsWith('POST')));
  const everything = JSON.stringify([out, env.logs, summaryOf(config(fake.url, one), out)]);
  assert.ok(!everything.includes(TOKEN));
});

test('the token is never printed on a successful run either', async () => {
  const fake = await fakeCoolify();
  const env = fakeEnv();
  const out = await run(config(fake.url, two), env.deps);
  await fake.close();
  assert.ok(!JSON.stringify([out, env.logs, summaryOf(config(fake.url, two), out)]).includes(TOKEN));
});

test('a redirect from Coolify is refused: nothing is sent on to the other host', async () => {
  const hits = [];
  const sink = http.createServer((req, res) => { hits.push(req.headers.authorization ?? '(no auth header)'); res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const fake = await fakeCoolify({}, { redirectVersion: `http://127.0.0.1:${sink.address().port}/steal` });
  const out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  await new Promise((resolve) => { sink.close(resolve); sink.closeAllConnections?.(); });
  assert.deepEqual([out.ok, out.code], [false, 'network']);
  assert.deepEqual(hits, [], 'the redirect target must never be contacted');
});

test('Coolify not returning a deployment id is a failure, not a silent success', async () => {
  const fake = await fakeCoolify({ [SERVER]: { startResponse: { body: { message: 'ok' } } } });
  const out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'no_deployment']);
});

test('a few failed polls are tolerated, a long silence is not', async () => {
  let fake = await fakeCoolify({ [SERVER]: { failPolls: 2 } });
  let out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.equal(out.ok, true);
  fake = await fakeCoolify({ [SERVER]: { failPolls: 10 } });
  out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'lost']);
});

test('site probe: retries until the site answers, fails with the URL and status when it never does', async () => {
  let fake = await fakeCoolify({ [SERVER]: { fqdn: 'https://site.example.test' } });
  let out = await run(config(fake.url, one), fakeEnv({ probes: [502, 502, 200] }).deps);
  await fake.close();
  assert.equal(out.ok, true);
  assert.equal(out.results[0].health[0].status, 200);
  fake = await fakeCoolify({ [SERVER]: { fqdn: 'https://site.example.test' } });
  out = await run(config(fake.url, one), fakeEnv({ probes: [502] }).deps);
  await fake.close();
  assert.deepEqual([out.ok, out.code], [false, 'health']);
  assert.match(out.results[0].error, /site\.example\.test\/ -> 502/);
});

test('an app with no https domain is deployed and the missing probe is noted', async () => {
  const fake = await fakeCoolify({ [SERVER]: { fqdn: 'http://plain.example.test' } });
  const out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.equal(out.ok, true);
  assert.ok(out.results[0].warnings.some((w) => /no https domain/.test(w)));
});

test('warnings when Coolify built another commit or reports none', async () => {
  let fake = await fakeCoolify({ [SERVER]: { commit: OTHER } });
  let out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.equal(out.ok, true);
  assert.ok(out.results[0].warnings.some((w) => /deployed bbbbbbb, CI tested aaaaaaa/.test(w)));
  fake = await fakeCoolify({ [SERVER]: { commit: null } });
  out = await run(config(fake.url, one), fakeEnv().deps);
  await fake.close();
  assert.ok(out.results[0].warnings.some((w) => /did not report which commit/.test(w)));
});

test('dry run reads and probes but never starts anything', async () => {
  const fake = await fakeCoolify();
  const out = await run(config(fake.url, two, { dryRun: true, expectedSha: '' }), fakeEnv().deps);
  await fake.close();
  assert.equal(out.ok, true);
  assert.deepEqual(out.results.map((r) => r.state), ['dry run (nothing deployed)', 'dry run (nothing deployed)']);
  assert.ok(!fake.calls.some((c) => c.startsWith('POST')));
  assert.match(summaryOf(config(fake.url, two, { dryRun: true }), out), /dry run/i);
});
