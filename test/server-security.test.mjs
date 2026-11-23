import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nextPath } from '../server/pages.mjs';
import { createServer as createYeet } from '../server/server.mjs';

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
// extra(port) adds environment, such as a content origin on another hostname of the same listener.
async function startServer(t, data, extra = () => ({})) {
  const port = await freePort();
  const local = `http://127.0.0.1:${port}`;
  const { YEET_CONTENT_ORIGIN, ...inherited } = process.env;
  const env = { ...inherited, YEET_DATA: data, YEET_PORT: String(port), YEET_ORIGIN: local, YEET_ADMIN_TOKEN: adminToken, YEET_INSECURE_COOKIE: '1', YEET_TRUST_PROXY: '1', ...extra(port) };
  const origin = env.YEET_ORIGIN;
  const child = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${local}/healthz`)).ok) return { origin, port, output: () => output }; } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${output}`);
}
const bearer = token => ({ Authorization: `Bearer ${token}` });
// What a browser sends for a link click or typed URL; grants are minted only for these.
const navigate = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' };
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
    const logout = await fetch(`${origin}/logout`, { method: 'POST', headers: { Cookie: other, Origin: origin }, redirect: 'manual' });
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

// Content-origin tests reach one listener under two hostnames by setting Host, as a reverse proxy would.
function hit(port, host, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: route, method, headers: { Host: host, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function publish(origin, token, visibility, files = { 'index.html': '<h1>page</h1>' }) {
  const created = await jsonRequest(origin, '/api/artifacts', { method: 'POST', headers: bearer(token), body: { visibility }, expected: 201 });
  const { n } = await jsonRequest(origin, `/api/artifacts/${created.id}/versions`, { method: 'POST', headers: bearer(token), body: { entry: 'index.html' }, expected: 201 });
  for (const [name, data] of Object.entries(files)) {
    const put = await fetch(`${origin}/api/artifacts/${created.id}/versions/${n}/files/${name}`, { method: 'PUT', headers: { ...bearer(token), 'Content-Type': 'text/html' }, body: data });
    assert.equal(put.status, 201);
  }
  await jsonRequest(origin, `/api/artifacts/${created.id}/versions/${n}/commit`, { method: 'POST', headers: bearer(token) });
  return created.id;
}

test('startup validates YEET_CONTENT_ORIGIN and keeps one private signing key', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-content-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = extra => ({ YEET_DATA: path.join(directory, 'data'), YEET_PORT: '0', YEET_ADMIN_TOKEN: adminToken, YEET_INSECURE_COOKIE: '1', ...extra });
  const refused = [
    [{ YEET_CONTENT_ORIGIN: 'https://content.example' }, /needs YEET_ORIGIN/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'https://yeet.example/' }, /different hostname/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'https://yeet.example:8443' }, /different hostname/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'https://content.example/pages' }, /YEET_CONTENT_ORIGIN must be an HTTP\(S\) origin/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'https://user:pw@content.example' }, /YEET_CONTENT_ORIGIN must be an HTTP\(S\) origin/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'ftp://content.example' }, /YEET_CONTENT_ORIGIN must be an HTTP\(S\) origin/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'not a url' }, /YEET_CONTENT_ORIGIN must be an HTTP\(S\) origin/],
    [{ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'http://content.example' }, /must use https when YEET_ORIGIN does/],
    [{ YEET_ORIGIN: 'http://localhost:3000', YEET_CONTENT_ORIGIN: 'http://[::1]:3000' }, /letters, digits, dots and hyphens/],
    [{ YEET_ORIGIN: 'http://localhost:3000', YEET_CONTENT_ORIGIN: 'http://pages_internal.localhost:3000' }, /letters, digits, dots and hyphens/],
  ];
  for (const [extra, message] of refused) await assert.rejects(createYeet(env(extra)), message, JSON.stringify(extra));
  // Compose passes an empty string when the variable is unset: that is legacy mode, not an error.
  await createYeet(env({ YEET_CONTENT_ORIGIN: '' }));
  await assert.rejects(readFile(path.join(directory, 'data', 'content-key')), { code: 'ENOENT' }, 'legacy mode makes no key');
  const ok = env({ YEET_ORIGIN: 'https://yeet.example', YEET_CONTENT_ORIGIN: 'https://yeet-content.example//' });
  await createYeet(ok);
  const keyFile = path.join(directory, 'data', 'content-key');
  const key = await readFile(keyFile);
  assert.equal(key.length, 32);
  if (process.platform !== 'win32') assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  await createYeet(ok);
  assert.deepEqual(await readFile(keyFile), key, 'a restart keeps the key, so page cookies survive it');
});

test('legacy single-origin mode serves pages on the account origin and warns once', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { origin, port, output } = await startServer(t, path.join(directory, 'data'), () => ({ YEET_CONTENT_ORIGIN: '' }));
  assert.deepEqual(await jsonRequest(origin, '/api/server'), { contentOrigin: null });
  const id = await publish(origin, adminToken, 'workspace');
  const cookie = await cookieFromLogin(origin, adminToken);
  assert.match(cookie, /^yeet_session=/, 'insecure cookies keep the old name');
  const host = `127.0.0.1:${port}`;
  const page = await hit(port, host, `/a/${id}/`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /sandbox allow-scripts allow-same-origin;/);
  assert.equal((await hit(port, host, `/a/${id}`, { headers: { Cookie: cookie } })).headers.location, `/a/${id}/`);
  assert.equal((await hit(port, host, `/.yeet/grant?t=x`)).status, 404);
  assert.match((await hit(port, host, '/login')).headers['content-security-policy'], /form-action 'self';/, 'legacy form-action stays self only');
  assert.equal(output().match(/YEET_CONTENT_ORIGIN/g)?.length, 1);
});

test('published pages are served from a separate content origin', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-content-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  const { origin, port, output } = await startServer(t, data, port => ({ YEET_ORIGIN: `http://yeet.test:${port}`, YEET_CONTENT_ORIGIN: `http://content.test:${port}/` }));
  const accountHost = `yeet.test:${port}`, contentHost = `content.test:${port}`, content = `http://${contentHost}`;
  const account = (route, options) => hit(port, accountHost, route, options);
  const onContent = (route, options) => hit(port, contentHost, route, options);
  // The JSON API is reached through the account Host as well.
  const api = async (route, { headers = {}, method = 'GET', body, expected = 200 } = {}) => {
    const response = await new Promise((resolve, reject) => {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest({ host: '127.0.0.1', port, path: route, method, headers: { Host: accountHost, Accept: 'application/json', ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
        let out = ''; res.setEncoding('utf8').on('data', c => { out += c; }).on('end', () => resolve({ status: res.statusCode, body: out }));
      });
      req.on('error', reject); req.end(text);
    });
    assert.equal(response.status, expected, `${method} ${route}: ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  const local = `http://127.0.0.1:${port}`; // publishing goes through the account router under its loopback Host
  assert.doesNotMatch(output(), /YEET_CONTENT_ORIGIN/, 'no legacy warning');
  const login = async token => {
    const response = await account(`/login?token=${encodeURIComponent(token)}&next=/`);
    assert.equal(response.status, 302);
    return response.headers['set-cookie'][0].split(';')[0];
  };
  const files = { 'index.html': '<h1>private page</h1>', 'sub/index.html': '<p>nested</p>' };
  const publicId = await publish(local, adminToken, 'public', { 'index.html': '<h1>public page</h1><link rel="stylesheet" href="/css/yeet-v1.css">' });
  const workspaceId = await publish(local, adminToken, 'workspace', files);
  const privateId = await publish(local, adminToken, 'private', files);
  await api('/api/members', { method: 'POST', headers: bearer(adminToken), body: { name: 'alice' }, expected: 201 });
  const aliceToken = (await api('/api/members/alice/tokens', { method: 'POST', headers: bearer(adminToken), body: { device: 'laptop' }, expected: 201 })).token;
  const adminCookie = await login(adminToken);
  assert.match(adminCookie, /^yeet_session=/);
  // Follows account -> grant -> content and returns the page cookie.
  async function contentCookie(cookie, id, route = `/a/${id}/`) {
    const handoff = await account(route, { headers: { ...navigate, Cookie: cookie } });
    assert.equal(handoff.status, 302, handoff.body);
    assert.ok(handoff.headers.location.startsWith(`${content}/.yeet/grant?t=`), handoff.headers.location);
    const granted = await onContent(handoff.headers.location.slice(content.length));
    assert.equal(granted.status, 302, granted.body);
    return { grant: handoff.headers.location.slice(content.length), location: granted.headers.location, setCookie: granted.headers['set-cookie'][0], cookie: granted.headers['set-cookie'][0].split(';')[0] };
  }
  const key = await readFile(path.join(data, 'content-key'));
  const signBody = (kind, body) => `${body}.${createHmac('sha256', key).update(`${kind}.${body}`).digest('base64url')}`;
  const forge = (kind, claim) => signBody(kind, Buffer.from(JSON.stringify(claim)).toString('base64url'));
  const claimOf = grant => JSON.parse(Buffer.from(new URLSearchParams(grant.split('?')[1]).get('t').split('.')[0], 'base64url'));

  await t.test('account routes 404 on the content host; the stylesheet and health check work there', async () => {
    for (const route of ['/', '/login', '/logout', '/setup', '/connect', '/devices', '/api/me', '/api/artifacts', '/people']) {
      const response = await onContent(route, { headers: { Authorization: `Bearer ${adminToken}`, Cookie: adminCookie } });
      assert.equal(response.status, 404, route);
      assert.equal(response.headers['set-cookie'], undefined);
    }
    assert.equal((await onContent('/login', { method: 'POST' })).status, 404);
    assert.equal((await onContent(`/a/${publicId}/`, { method: 'POST' })).status, 404);
    const css = await onContent('/css/yeet-v1.css');
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
    assert.equal((await onContent('/healthz')).status, 200);
    assert.equal((await onContent('/healthz', { method: 'HEAD' })).status, 200);
    assert.equal((await hit(port, contentHost.toUpperCase(), '/api/me', { headers: bearer(adminToken) })).status, 404, 'Host is compared case-insensitively');
    assert.equal((await account('/.yeet/grant?t=x')).status, 404, 'grants are redeemed only on the content host');
    // Sign-in with next=/a/... redirects on to the content origin; form-action must allow it.
    assert.match((await account('/login')).headers['content-security-policy'], new RegExp(`form-action 'self' ${content};`));
    assert.deepEqual(await api('/api/server'), { contentOrigin: content }, 'the account origin advertises the content origin without auth');
    assert.equal((await onContent('/api/server')).status, 404);
    const forwarded = await account('/api/me', { headers: { ...bearer(adminToken), 'X-Forwarded-Host': contentHost } });
    assert.equal(forwarded.status, 200, 'X-Forwarded-Host is never consulted');
  });

  await t.test('a public page redirects to the content origin and is served there without a cookie', async () => {
    const moved = await account(`/a/${publicId}/?ref=1`);
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.location, `${content}/a/${publicId}/?ref=1`);
    assert.equal((await account(`/a/${publicId}`)).headers.location, `${content}/a/${publicId}/`);
    assert.equal((await account(`/a/${publicId}/`, { headers: { Cookie: adminCookie } })).headers.location, `${content}/a/${publicId}/`, 'signed-in browsers need no grant for public pages');
    const served = await onContent(`/a/${publicId}/?ref=1`);
    assert.equal(served.status, 200);
    assert.match(served.body, /public page/);
    assert.match(served.headers['content-security-policy'], /sandbox allow-scripts allow-same-origin;.*connect-src 'none'/);
    assert.equal(served.headers['cross-origin-opener-policy'], 'unsafe-none');
    assert.equal(served.headers['set-cookie'], undefined);
  });

  await t.test('bearer clients are served on the account host; unauthenticated JSON still gets 401', async () => {
    for (const id of [workspaceId, privateId]) {
      const served = await account(`/a/${id}/`, { headers: bearer(adminToken) });
      assert.equal(served.status, 200);
      assert.match(served.body, /private page/);
      assert.match(served.headers['content-security-policy'], /connect-src 'none'/);
    }
    assert.equal((await account(`/a/${publicId}/`, { headers: bearer(adminToken) })).status, 200);
    assert.equal((await account(`/a/${privateId}/`, { headers: { Accept: 'application/json' } })).status, 401);
    const anonymous = await account(`/a/${workspaceId}/sub/`);
    assert.equal(anonymous.headers.location, `/login?next=${encodeURIComponent(`/a/${workspaceId}/sub/`)}`);
    assert.equal((await account(`/a/${privateId}/`, { headers: bearer(aliceToken) })).status, 404, 'unreadable stays 404');
    assert.equal((await account(`/a/${privateId}/`, { headers: { Cookie: await login(aliceToken) } })).status, 404, 'no grant for an unreadable page');
    // Only a verified Bearer member is served here; other Authorization (a proxy's Basic auth) is a browser.
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Bearer not-a-real-token']) {
      const moved = await account(`/a/${publicId}/`, { headers: { Authorization: authorization } });
      assert.equal(moved.status, 302, authorization);
      assert.equal(moved.headers.location, `${content}/a/${publicId}/`);
    }
    assert.equal((await account(`/a/${privateId}/`, { headers: { Authorization: 'Basic dXNlcjpwYXNz' } })).status, 401, 'unchanged: unverified Authorization on a non-public page');
  });

  await t.test('bearer bytes on the account host are never stored by a shared cache', async () => {
    for (const id of [publicId, workspaceId, privateId]) {
      const served = await account(`/a/${id}/`, { headers: bearer(adminToken) });
      assert.equal(served.status, 200);
      assert.equal(served.headers['cache-control'], 'private, no-store', id);
      assert.equal((await account(`/a/${id}`, { headers: bearer(adminToken) })).headers['cache-control'], 'private, no-store');
    }
    assert.equal((await onContent(`/a/${publicId}/`)).headers['cache-control'], 'public, max-age=60', 'the content host keeps its policy');
  });

  await t.test('grants are minted only for top-level navigations', async () => {
    const asked = headers => account(`/a/${privateId}/sub/`, { headers: { Cookie: adminCookie, ...headers } });
    const navigation = await asked({ ...navigate, 'Sec-Fetch-Site': 'same-site' });
    assert.equal(navigation.status, 302);
    assert.ok(navigation.headers.location.startsWith(`${content}/.yeet/grant?t=`));
    const subresources = [
      { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' },
      { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe' },
      { 'Sec-Fetch-Mode': 'cors' },
      { 'Sec-Fetch-Dest': 'image' },
    ];
    for (const headers of subresources) {
      const response = await asked(headers);
      assert.equal(response.status, 404, JSON.stringify(headers));
      assert.equal(response.headers.location, undefined);
    }
    const image = await account(`/a/${publicId}/`, { headers: { 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' } });
    assert.equal(image.headers.location, `${content}/a/${publicId}/`, 'public pages still redirect for subresources');
  });

  await t.test('without a user-started navigation the account origin asks for a click instead', async () => {
    const unproven = {
      'script-started navigation (no ?1)': { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-site' },
      'Sec-Purpose prefetch': { ...navigate, 'Sec-Purpose': 'prefetch' },
      'legacy Purpose prefetch': { ...navigate, Purpose: 'prefetch' },
      'no Fetch Metadata': {},
      '?0': { ...navigate, 'Sec-Fetch-User': '?0' },
      '?1 without mode and dest': { 'Sec-Fetch-User': '?1' },
    };
    for (const [name, headers] of Object.entries(unproven)) {
      const response = await account(`/a/${workspaceId}/sub/?q=1`, { headers: { ...headers, Cookie: adminCookie } });
      assert.equal(response.status, 200, name);
      assert.equal(response.headers.location, undefined, name);
      assert.equal(response.headers['set-cookie'], undefined, name);
      assert.equal(response.headers['cache-control'], 'no-store', name);
      assert.match(response.headers['content-security-policy'], /default-src 'none'.*form-action 'self'/, name);
      assert.match(response.body, /<h1>Open this page<\/h1>/, name);
      // No action: the form posts to the current URL, so a #fragment survives the redirects.
      assert.ok(response.body.includes(`<form method="post"><button type="submit">Open ${workspaceId}</button>`), name);
      assert.match(response.headers['content-security-policy'], new RegExp(`form-action 'self' ${content};`), 'the post may end on the content origin');
    }
    // The page name is escaped.
    const named = await jsonRequest(local, '/api/artifacts', { method: 'POST', headers: bearer(adminToken), body: { visibility: 'workspace', name: '<b>"x"</b>' }, expected: 201 });
    const shown = await account(`/a/${named.id}/`, { headers: { Cookie: adminCookie } });
    assert.ok(shown.body.includes('Open &lt;b&gt;&quot;x&quot;&lt;/b&gt;</button>'), shown.body);
    assert.doesNotMatch(shown.body, /<b>"x"/);
    // Submitting the form from the account origin hands over through a working grant.
    const post = (headers, route = `/a/${workspaceId}/sub/?q=1`) => account(route, { method: 'POST', headers: { Cookie: adminCookie, ...headers } });
    const submitted = await post({ Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(submitted.status, 303);
    assert.ok(submitted.headers.location.startsWith(`${content}/.yeet/grant?t=`));
    const granted = await onContent(submitted.headers.location.slice(content.length));
    assert.equal(granted.headers.location, `/a/${workspaceId}/sub/?q=1`);
    assert.equal((await onContent(granted.headers.location, { headers: { Cookie: granted.headers['set-cookie'][0].split(';')[0] } })).status, 200);
    for (const headers of [{ Origin: content }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }]) {
      const refused = await post(headers);
      assert.equal(refused.status, 403, JSON.stringify(headers));
      assert.equal(refused.headers.location, undefined);
    }
    assert.equal((await post({ Origin: origin }, `/a/${publicId}/`)).headers.location, `${content}/a/${publicId}/`, 'public pages hand over directly');
    assert.match((await account(`/a/${workspaceId}/`, { method: 'POST', headers: { Origin: origin } })).headers.location, /^\/login\?next=/, 'signed out: sign in first');
    const alicePrivate = await publish(local, aliceToken, 'private');
    assert.equal((await post({ Origin: origin }, `/a/${alicePrivate}/`)).status, 404, 'unreadable stays 404');
    assert.equal((await account(`/a/${workspaceId}/`, { method: 'POST', headers: { ...bearer(adminToken), Origin: origin } })).status, 404, 'bearer clients do not post');
    for (const headers of [{}, { 'Sec-Fetch-Site': 'same-origin' }]) {
      assert.equal((await post(headers)).status, 403, `no Origin is no evidence: ${JSON.stringify(headers)}`);
    }
    // The form posts to whatever URL showed it; the grant still targets the canonical path.
    const loose = await post({ Origin: origin }, `/%61/${workspaceId}/sub/?q=1`);
    assert.equal((await onContent(loose.headers.location.slice(content.length))).headers.location, `/a/${workspaceId}/sub/?q=1`);
    assert.equal((await onContent(`/a/${publicId}/`, { method: 'POST' })).status, 404, 'no POST on the content host');
  });

  await t.test('the grant target is canonical even when the request path was percent-encoded', async () => {
    const encodedId = `%${workspaceId.charCodeAt(0).toString(16)}${workspaceId.slice(1)}`;
    for (const [route, expected] of [[`/%61/${workspaceId}/sub/?q=1`, `/a/${workspaceId}/sub/?q=1`], [`/a/${encodedId}/sub/index%2Ehtml`, `/a/${workspaceId}/sub/index.html`], [`/a/${encodedId}`, `/a/${workspaceId}/`]]) {
      const { location, cookie } = await contentCookie(adminCookie, workspaceId, route);
      assert.equal(location, expected, route);
      assert.equal((await onContent(location, { headers: { Cookie: cookie } })).status, 200, route);
    }
    assert.equal((await account(`/%61/${publicId}/`)).headers.location, `${content}/a/${publicId}/`);
  });

  await t.test('HEAD follows the whole handoff and spends the grant', async () => {
    const handoff = await account(`/a/${privateId}/`, { method: 'HEAD', headers: { ...navigate, Cookie: adminCookie } });
    assert.equal(handoff.status, 302);
    const grant = handoff.headers.location.slice(content.length);
    const granted = await onContent(grant, { method: 'HEAD' });
    assert.equal(granted.status, 302);
    const page = await onContent(granted.headers.location, { method: 'HEAD', headers: { Cookie: granted.headers['set-cookie'][0].split(';')[0] } });
    assert.equal(page.status, 200);
    assert.equal(page.body, '');
    assert.equal((await onContent(grant)).status, 403, 'a grant spent by HEAD cannot be used again');
  });

  await t.test('a browser is handed over through a grant to a page-scoped cookie', async () => {
    const { grant, location, setCookie, cookie } = await contentCookie(adminCookie, workspaceId, `/a/${workspaceId}/sub/?q=1`);
    assert.equal(location, `/a/${workspaceId}/sub/?q=1`);
    assert.match(setCookie, new RegExp(`^yeet_content=[^;]+; Path=/a/${workspaceId}/; HttpOnly; SameSite=Lax; Max-Age=43200$`));
    const claim = claimOf(grant);
    assert.deepEqual(Object.keys(claim).sort(), ['artifact', 'exp', 'member', 'nonce', 'path', 'sid']);
    assert.ok(claim.exp - Date.now() <= 60_000);
    const served = await onContent(location, { headers: { Cookie: cookie } });
    assert.equal(served.status, 200);
    assert.match(served.body, /nested/);
    assert.match(served.headers['content-security-policy'], /sandbox allow-scripts allow-same-origin;/);
    assert.equal(served.headers['cache-control'], 'private, no-cache');
    // Any one valid page cookie among several works, so junk cookies cannot shadow it.
    assert.equal((await onContent(`/a/${workspaceId}/`, { headers: { Cookie: `yeet_content=junk; ${cookie}; yeet_content=a.b` } })).status, 200);
    const missing = await onContent(`/a/${workspaceId}/sub/?q=1`);
    assert.equal(missing.status, 302);
    assert.equal(missing.headers.location, `${origin}/a/${workspaceId}/sub/?q=1`, 'without a cookie the account origin re-mints');
    // The bare form is handed over with its slash, so the Path-scoped cookie is sent on arrival.
    const bare = await contentCookie(adminCookie, privateId, `/a/${privateId}?v=1`);
    assert.equal(bare.location, `/a/${privateId}/?v=1`);
    const pinned = await onContent(bare.location, { headers: { Cookie: bare.cookie } });
    assert.equal(pinned.headers.location, `/a/${privateId}/v/1/`, 'version pins redirect on the content host');
    assert.equal((await onContent(`/a/${privateId}/v/1`, { headers: { Cookie: bare.cookie } })).headers.location, `/a/${privateId}/v/1/`);
    assert.equal((await onContent(`/a/${privateId}/v/1/`, { headers: { Cookie: bare.cookie } })).status, 200);
    assert.equal((await onContent(`/a/${publicId}`)).headers.location, `/a/${publicId}/`, 'trailing slash redirect on the content host');
    assert.equal((await onContent(`/a/${publicId}/?v=1`)).headers.location, `/a/${publicId}/v/1/`);
    assert.equal((await onContent(`/a/${publicId}/?v=x`)).status, 400);
    assert.equal((await onContent(`/a/${workspaceId}/`, { headers: { Cookie: bare.cookie } })).status, 302, 'a cookie for one page does not open another');
  });

  await t.test('replayed, expired, tampered, cross-kind and out-of-scope grants get a 403 page', async () => {
    const { grant } = await contentCookie(adminCookie, workspaceId);
    const replay = await onContent(grant);
    assert.equal(replay.status, 403);
    assert.match(replay.body, /This link expired\. Reopen it from Yeet\./);
    assert.ok(replay.body.includes(`href="${origin}/a/${workspaceId}/"`), 'links back to the page on the account origin');
    assert.equal(replay.headers['set-cookie'], undefined);
    const claim = claimOf(grant);
    const fresh = extra => `/.yeet/grant?t=${forge('grant', { ...claim, nonce: `n${Math.random()}`, ...extra })}`;
    assert.equal((await onContent(fresh({}))).status, 302, 'control: a correctly signed fresh grant works');
    const other = await publish(local, adminToken, 'workspace');
    const token = new URLSearchParams(grant.split('?')[1]).get('t');
    const [body, signature] = token.split('.');
    const cases = {
      expired: fresh({ exp: Date.now() - 1 }),
      'other artifact path': fresh({ path: `/a/${other}/` }),
      'prefix trick path': fresh({ path: `/a/${workspaceId}x/` }),
      'absolute path': fresh({ path: `//evil.example/a/${workspaceId}/` }),
      'other session': fresh({ sid: 'f'.repeat(24) }),
      'other member': fresh({ member: 'alice' }),
      'unknown artifact': fresh({ artifact: 'AAAAAAAAAAAA', path: '/a/AAAAAAAAAAAA/' }),
      'bad artifact id': fresh({ artifact: '../../x', path: '/a/../../x/' }),
      'string exp': fresh({ exp: String(Date.now() + 60_000) }),
      'cookie as grant': `/.yeet/grant?t=${forge('cookie', { ...claim, nonce: 'k1' })}`,
      'tampered payload': `/.yeet/grant?t=${Buffer.from(JSON.stringify({ ...claim, nonce: 'x', artifact: other, path: `/a/${other}/` })).toString('base64url')}.${signature}`,
      'tampered signature': `/.yeet/grant?t=${body}.${signature.slice(0, -2)}AA`,
      'short signature': `/.yeet/grant?t=${body}.AAAA`,
      'three parts': `/.yeet/grant?t=${token}.x`,
      'not json': `/.yeet/grant?t=${signBody('grant', Buffer.from('{').toString('base64url'))}`,
      'null claim': `/.yeet/grant?t=${forge('grant', null)}`,
      missing: '/.yeet/grant',
      empty: '/.yeet/grant?t=',
      garbage: '/.yeet/grant?t=%E2%82%AC..',
    };
    for (const [name, route] of Object.entries(cases)) {
      const response = await onContent(route);
      assert.equal(response.status, 403, `${name}: ${response.body}`);
      assert.equal(response.headers['set-cookie'], undefined, name);
    }
    assert.equal((await onContent(grant, { method: 'HEAD' })).status, 403, 'HEAD cannot replay a spent grant');
    assert.doesNotMatch(output(), /Unexpected error/);
  });

  await t.test('forged or stale page cookies are refused', async () => {
    const { cookie } = await contentCookie(adminCookie, workspaceId);
    const claim = JSON.parse(Buffer.from(cookie.slice('yeet_content='.length).split('.')[0], 'base64url'));
    const tryCookie = (value, id = workspaceId) => onContent(`/a/${id}/`, { headers: { Cookie: `yeet_content=${value}` } });
    assert.equal((await tryCookie(forge('cookie', claim))).status, 200, 'control');
    assert.equal((await tryCookie(forge('cookie', { ...claim, exp: Date.now() - 1 }))).status, 302);
    assert.equal((await tryCookie(forge('grant', claim))).status, 302, 'a grant is not a cookie');
    assert.equal((await tryCookie(cookie.slice('yeet_content='.length), privateId)).status, 302);
  });

  await t.test('the content cookie stops working on logout, member removal and visibility changes', async () => {
    const browser = await login(adminToken);
    const { cookie } = await contentCookie(browser, privateId);
    assert.equal((await onContent(`/a/${privateId}/`, { headers: { Cookie: cookie } })).status, 200);
    // A GET /logout from anywhere but this origin or the address bar only asks, so a sibling origin cannot
    // sign viewers out with an <img>.
    for (const site of ['same-site', 'cross-site']) {
      const asked = await account('/logout', { headers: { Cookie: browser, 'Sec-Fetch-Site': site } });
      assert.equal(asked.status, 200, site);
      assert.equal(asked.headers['set-cookie'], undefined, site);
    }
    assert.equal((await account('/logout', { headers: { Cookie: browser, Origin: content, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    const confirm = await account('/logout', { headers: { Cookie: browser } });
    assert.equal(confirm.status, 200, 'no Fetch Metadata: confirm instead of logging out');
    assert.equal(confirm.headers['set-cookie'], undefined);
    assert.match(confirm.body, /<form method="post" action="\/logout"><button type="submit">Log out<\/button><\/form>/);
    assert.equal((await account('/logout', { method: 'POST', headers: { Cookie: browser, Origin: content } })).status, 403, 'a POST from the content origin is refused');
    assert.equal((await account('/logout', { method: 'POST', headers: { Cookie: browser } })).status, 403, 'a POST without Origin is refused');
    assert.equal((await account('/logout', { method: 'POST', headers: { Cookie: browser, 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    assert.equal((await onContent(`/a/${privateId}/`, { headers: { Cookie: cookie } })).status, 200, 'still signed in');
    const other = await login(adminToken);
    const posted = await account('/logout', { method: 'POST', headers: { Cookie: other, Origin: origin } });
    assert.equal(posted.status, 302);
    assert.match(posted.headers['set-cookie'][0], /^yeet_session=; .*Max-Age=0/);
    await api('/api/me', { headers: { Cookie: other }, expected: 401 });
    assert.equal((await account('/logout', { headers: { Cookie: browser, 'Sec-Fetch-Site': 'same-origin' } })).status, 302);
    const loggedOut = await onContent(`/a/${privateId}/`, { headers: { Cookie: cookie } });
    assert.equal(loggedOut.status, 302);
    assert.equal(loggedOut.headers.location, `${origin}/a/${privateId}/`);
    assert.match((await account(`/a/${privateId}/`, { headers: { Cookie: browser } })).headers.location, /^\/login\?next=/, 'and the account origin asks to sign in');

    const shared = await publish(local, adminToken, 'workspace');
    const alice = await login(aliceToken);
    const aliceCookie = (await contentCookie(alice, shared)).cookie;
    const ownerCookie = (await contentCookie(adminCookie, shared)).cookie;
    assert.equal((await onContent(`/a/${shared}/`, { headers: { Cookie: aliceCookie } })).status, 200);
    await api(`/api/artifacts/${shared}`, { method: 'PATCH', headers: bearer(adminToken), body: { visibility: 'private' } });
    assert.equal((await onContent(`/a/${shared}/`, { headers: { Cookie: aliceCookie } })).status, 302, 'made private: non-owner is out');
    assert.equal((await onContent(`/a/${shared}/`, { headers: { Cookie: ownerCookie } })).status, 200, 'the owner keeps access');
    await api(`/api/artifacts/${shared}`, { method: 'PATCH', headers: bearer(adminToken), body: { visibility: 'workspace' } });
    assert.equal((await onContent(`/a/${shared}/`, { headers: { Cookie: aliceCookie } })).status, 200);
    const pending = await account(`/a/${shared}/`, { headers: { ...navigate, Cookie: alice } });
    await api('/api/members/alice', { method: 'DELETE', headers: bearer(adminToken) });
    assert.equal((await onContent(`/a/${shared}/`, { headers: { Cookie: aliceCookie } })).status, 302, 'removed member is out');
    assert.equal((await onContent(pending.headers.location.slice(content.length))).status, 403, 'an unspent grant dies with the member');
  });

  await t.test('setting a first password ends the browser\'s old session and its page cookies', async () => {
    await api('/api/members', { method: 'POST', headers: bearer(adminToken), body: { name: 'carol' }, expected: 201 });
    const carolToken = (await api('/api/members/carol/tokens', { method: 'POST', headers: bearer(adminToken), body: { device: 'laptop' }, expected: 201 })).token;
    const page = await publish(local, carolToken, 'private');
    const before = await login(carolToken); // token-only: no password yet
    const { cookie } = await contentCookie(before, page);
    assert.equal((await onContent(`/a/${page}/`, { headers: { Cookie: cookie } })).status, 200);
    const saved = await account('/account', { method: 'POST', body: new URLSearchParams({ password: 'a long test password' }).toString(),
      headers: { Cookie: before, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(saved.status, 200, saved.body);
    const after = saved.headers['set-cookie'][0].split(';')[0];
    const stale = await onContent(`/a/${page}/`, { headers: { Cookie: cookie } });
    assert.equal(stale.status, 302, 'the page cookie of the replaced session is refused');
    assert.equal(stale.headers.location, `${origin}/a/${page}/`);
    await api('/api/me', { headers: { Cookie: before }, expected: 401 });
    assert.equal((await api('/api/me', { headers: { Cookie: after } })).name, 'carol');
    assert.equal((await api('/api/me', { headers: bearer(carolToken) })).name, 'carol', 'terminals keep working after a first password');
    const fresh = (await contentCookie(after, page)).cookie;
    assert.equal((await onContent(`/a/${page}/`, { headers: { Cookie: fresh } })).status, 200);
  });

  await t.test('a password reset ends the page cookies of the old session', async () => {
    const { inviteUrl } = await api('/api/members', { method: 'POST', headers: bearer(adminToken), body: { name: 'bob' }, expected: 201 });
    const join = async url => {
      const response = await account('/join', { method: 'POST', body: new URLSearchParams({ code: new URL(url).searchParams.get('code'), password: 'a long test password' }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin } });
      assert.equal(response.status, 302, response.body);
      return response.headers['set-cookie'][0].split(';')[0];
    };
    const { cookie } = await contentCookie(await join(inviteUrl), workspaceId);
    assert.equal((await onContent(`/a/${workspaceId}/`, { headers: { Cookie: cookie } })).status, 200);
    const reset = await api('/api/members/bob/invite', { method: 'POST', headers: bearer(adminToken), expected: 201 });
    const fresh = await join(reset.inviteUrl);
    assert.equal((await onContent(`/a/${workspaceId}/`, { headers: { Cookie: cookie } })).status, 302, 'the reset signed the old session out');
    assert.equal((await onContent(`/a/${workspaceId}/`, { headers: { Cookie: (await contentCookie(fresh, workspaceId)).cookie } })).status, 200);
  });

  await t.test('each origin ignores the other origin\'s credentials', async () => {
    const { cookie } = await contentCookie(adminCookie, workspaceId);
    await api('/api/me', { headers: { Cookie: cookie }, expected: 401 });
    const onAccount = await account(`/a/${workspaceId}/`, { headers: { Cookie: cookie } });
    assert.match(onAccount.headers.location, /^\/login\?next=/, 'the page cookie is not a session on the account host');
    for (const headers of [{ Cookie: adminCookie }, bearer(adminToken), { ...bearer(adminToken), Cookie: adminCookie }]) {
      const response = await onContent(`/a/${workspaceId}/`, { headers });
      assert.equal(response.status, 302, JSON.stringify(headers));
      assert.equal(response.headers.location, `${origin}/a/${workspaceId}/`);
    }
  });
});

test('secure cookies use the __Host- session name and the page cookie is Secure', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-host-cookie-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { port } = await startServer(t, path.join(directory, 'data'), port => ({ YEET_ORIGIN: `http://yeet.test:${port}`, YEET_CONTENT_ORIGIN: `http://content.test:${port}`, YEET_INSECURE_COOKIE: '0' }));
  const accountHost = `yeet.test:${port}`, contentHost = `content.test:${port}`;
  const login = await hit(port, accountHost, `/login?token=${adminToken}&next=/`);
  const setCookie = login.headers['set-cookie'][0];
  assert.match(setCookie, /^__Host-yeet_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
  const value = setCookie.split(';')[0].split('=')[1];
  const me = cookie => hit(port, accountHost, '/api/me', { headers: { Accept: 'application/json', Cookie: cookie } });
  assert.equal((await me(`__Host-yeet_session=${value}`)).status, 200);
  assert.equal((await me(`yeet_session=${value}`)).status, 401, 'the unprefixed name a sibling could toss in is ignored');
  const id = await publish(`http://127.0.0.1:${port}`, adminToken, 'workspace');
  const handoff = await hit(port, accountHost, `/a/${id}/`, { headers: { ...navigate, Cookie: `__Host-yeet_session=${value}` } });
  const granted = await hit(port, contentHost, handoff.headers.location.slice(`http://${contentHost}`.length));
  assert.match(granted.headers['set-cookie'][0], /^yeet_content=[^;]+; Path=\/a\/[^/]+\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
  const logout = await hit(port, accountHost, '/logout', { headers: { 'Sec-Fetch-Site': 'same-origin', Cookie: `__Host-yeet_session=${value}` } });
  assert.match(logout.headers['set-cookie'][0], /^__Host-yeet_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0; Secure$/);
  assert.equal((await me(`__Host-yeet_session=${value}`)).status, 401);
});
