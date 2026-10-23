import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nextPath } from '../server/pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverEntry = path.join(root, 'server', 'server.mjs');
const cli = path.join(root, 'cli', 'yeet.mjs');
const adminToken = 'security-test-admin-token';

async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function startServer(t, data) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, YEET_DATA: data, YEET_PORT: String(port), YEET_ORIGIN: origin, YEET_ADMIN_TOKEN: adminToken, YEET_INSECURE_COOKIE: '1', YEET_TRUST_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) return { origin }; } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${output}`);
}
const bearer = token => ({ Authorization: `Bearer ${token}` });
const formPost = (body, headers = {}) => ({ method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
async function jsonRequest(origin, route, { headers = {}, method = 'GET', body, expected = 200 } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, redirect: 'manual' };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const response = await fetch(`${origin}${route}`, init);
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route}: ${text}`);
  return text ? JSON.parse(text) : null;
}
async function cookieFromLogin(origin, token) {
  const response = await fetch(`${origin}/login?token=${encodeURIComponent(token)}&next=/`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';')[0];
}

test('nextPath refuses protocol-relative destinations even after normalization', () => {
  assert.equal(nextPath('/a/..//evil.example'), '/');
  assert.equal(nextPath('//evil.example/x'), '/');
  assert.equal(nextPath('/a/abc/?v=1'), '/a/abc/?v=1');
  assert.equal(nextPath('https://evil.example'), '/');
});

test('security fixes from the auth review', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-sec-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { origin } = await startServer(t, path.join(directory, 'data'));

  await t.test('every artifact response carries the CSP, including SVG', async () => {
    const created = await jsonRequest(origin, '/api/artifacts', { method: 'POST', headers: bearer(adminToken), body: { visibility: 'public' }, expected: 201 });
    const { n } = await jsonRequest(origin, `/api/artifacts/${created.id}/versions`, { method: 'POST', headers: bearer(adminToken), body: { entry: 'index.html' }, expected: 201 });
    const put = (name, data, type) => fetch(`${origin}/api/artifacts/${created.id}/versions/${n}/files/${name}`, { method: 'PUT', headers: { ...bearer(adminToken), 'Content-Type': type }, body: data });
    assert.equal((await put('index.html', '<img src="evil.svg">', 'text/html')).status, 201);
    assert.equal((await put('evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/me")</script></svg>', 'image/svg+xml')).status, 201);
    await jsonRequest(origin, `/api/artifacts/${created.id}/versions/${n}/commit`, { method: 'POST', headers: bearer(adminToken) });
    for (const file of ['', 'evil.svg']) {
      const response = await fetch(`${origin}/a/${created.id}/${file}`);
      assert.equal(response.status, 200);
      const csp = response.headers.get('content-security-policy') || '';
      assert.match(csp, /connect-src 'none'/, `${file || 'entry'} must forbid fetch`);
      assert.match(csp, /form-action 'none'/);
      assert.match(csp, /sandbox allow-scripts allow-same-origin;/);
      assert.doesNotMatch(csp, /allow-popups|allow-forms|allow-top-navigation/);
      assert.match(csp, /frame-src 'none'; frame-ancestors 'none'; worker-src 'none'/);
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'unsafe-none');
    }
  });

  await t.test('revoking a device token kills the browser sessions it created; logout deletes the session', async () => {
    const minted = await jsonRequest(origin, '/api/members/admin/tokens', { method: 'POST', headers: bearer(adminToken), body: { device: 'laptop' }, expected: 201 });
    const cookie = await cookieFromLogin(origin, minted.token);
    assert.equal((await jsonRequest(origin, '/api/me', { headers: { Cookie: cookie } })).name, 'admin');
    await jsonRequest(origin, `/api/tokens/${minted.id}`, { method: 'DELETE', headers: bearer(adminToken) });
    await jsonRequest(origin, '/api/me', { headers: { Cookie: cookie }, expected: 401 });
    const other = await cookieFromLogin(origin, adminToken);
    assert.equal((await jsonRequest(origin, '/api/me', { headers: { Cookie: other } })).name, 'admin');
    const logout = await fetch(`${origin}/logout`, { headers: { Cookie: other }, redirect: 'manual' });
    assert.equal(logout.status, 302);
    await jsonRequest(origin, '/api/me', { headers: { Cookie: other }, expected: 401 }, 'a replayed cookie is dead after logout');
  });

  await t.test('cross-site form posts are refused and a signed-in browser is never silently re-identified', async () => {
    const cookie = await cookieFromLogin(origin, adminToken);
    const begun = await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: 'x' }, expected: 201 });
    const crossSite = { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' };
    assert.equal((await fetch(`${origin}/devices/add`, formPost({ code: begun.userCode, action: 'add' }, crossSite))).status, 403);
    assert.equal((await fetch(`${origin}/login`, formPost({ token: adminToken, next: '/' }, { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
    const sameSite = { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' };
    assert.equal((await fetch(`${origin}/devices/add`, formPost({ code: begun.userCode, action: 'add' }, sameSite))).status, 403, 'sibling origins are refused too');
    assert.deepEqual(await jsonRequest(origin, `/api/device/${begun.code}`), { status: 'pending' }, 'nothing was approved');
    const sameOrigin = { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' };
    assert.equal((await fetch(`${origin}/devices/add`, formPost({ code: begun.userCode, action: 'deny' }, sameOrigin))).status, 200);
    // A logged-in browser hitting a token login link keeps its identity and gets a 409 page instead.
    const alice = await jsonRequest(origin, '/api/members', { method: 'POST', headers: bearer(adminToken), body: { name: 'alice' }, expected: 201 });
    const aliceToken = (await jsonRequest(origin, '/api/members/alice/tokens', { method: 'POST', headers: bearer(adminToken), body: { device: 'phone' }, expected: 201 })).token;
    const swap = await fetch(`${origin}/login?token=${aliceToken}&next=/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(swap.status, 409);
    assert.equal(swap.headers.get('set-cookie'), null);
    assert.equal((await jsonRequest(origin, '/api/me', { headers: { Cookie: cookie } })).name, 'admin');
    const joinSwap = await fetch(alice.inviteUrl, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(joinSwap.status, 409);
    assert.equal((await fetch(alice.inviteUrl, { redirect: 'manual' })).status, 200, 'the invite is still unused');
  });

  await t.test('per-client throttle on pending logins; approved token survives a lost response', async () => {
    const asClient = ip => ({ method: 'POST', body: { device: 'agent' }, headers: { 'X-Forwarded-For': ip } });
    for (let i = 0; i < 10; i++) await jsonRequest(origin, '/api/device', { ...asClient('203.0.113.9'), expected: 201 });
    await jsonRequest(origin, '/api/device', { ...asClient('203.0.113.9'), expected: 429 });
    await jsonRequest(origin, '/api/device', { ...asClient('203.0.113.10'), expected: 201 }, 'other clients are unaffected');
    const cookie = await cookieFromLogin(origin, adminToken);
    const begun = await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: 'flaky-net' }, expected: 201 });
    assert.equal((await fetch(`${origin}/devices/add`, formPost({ code: begun.userCode, action: 'add' }, { Cookie: cookie }))).status, 200);
    const first = await jsonRequest(origin, `/api/device/${begun.code}`);
    const second = await jsonRequest(origin, `/api/device/${begun.code}`);
    assert.equal(first.status, 'approved');
    assert.equal(second.token, first.token, 'a retry within the grace window gets the same token');
    // Once approved, the same code cannot be approved or denied again.
    assert.equal((await fetch(`${origin}/devices/add`, formPost({ code: begun.userCode, action: 'add' }, { Cookie: cookie }))).status, 404);
    assert.equal((await fetch(`${origin}/devices/add`, formPost({ code: begun.userCode, action: 'deny' }, { Cookie: cookie }))).status, 404);
  });

  await t.test('the CLI does not send a token saved for one origin to another origin', async () => {
    const home = path.join(directory, 'home');
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ origin, token: adminToken }));
    let seenAuthorization = 'never-called';
    const capture = createServer((req, res) => { seenAuthorization = req.headers.authorization; res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"nope"}'); });
    capture.listen(0, '127.0.0.1');
    await once(capture, 'listening');
    t.after(() => new Promise(resolve => capture.close(resolve)));
    const other = `http://127.0.0.1:${capture.address().port}`;
    const env = { ...process.env, YEET_HOME: home };
    delete env.YEET_TOKEN; delete env.YEET_ORIGIN;
    const child = spawn(process.execPath, [cli, 'whoami', '--origin', other], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'close');
    assert.equal(code, 2, stderr);
    assert.match(stderr, /not logged in/);
    assert.equal(seenAuthorization, 'never-called', 'the saved token must not leave for a different origin');
    const ok = spawn(process.execPath, [cli, 'whoami'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    ok.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    assert.equal((await once(ok, 'close'))[0], 0);
    assert.match(stdout, /"name": "admin"/);
  });
});
