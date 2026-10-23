import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../server/server.mjs';
import { passwordHash, passwordMatches, loginThrottle } from '../server/passwords.mjs';
import { recoveryLink } from '../server/recover.mjs';
import { browserCommand } from '../cli/browser.mjs';

const password = 'a long test password';
async function instance(t, extra = {}) {
  const data = await mkdtemp(path.join(tmpdir(), 'yeet-accounts-'));
  let running;
  const env = { YEET_DATA: data, YEET_PORT: '0', YEET_INSECURE_COOKIE: '1', ...extra };
  const app = { data, env };
  app.start = async () => {
    running = await createServer(env);
    running.server.listen(0, '127.0.0.1');
    await once(running.server, 'listening');
    app.origin = `http://127.0.0.1:${running.server.address().port}`;
  };
  app.stop = async () => {
    if (!running?.server.listening) return;
    running.server.closeAllConnections();
    await new Promise(resolve => running.server.close(resolve));
  };
  app.get = (route, cookie) => fetch(`${app.origin}${route}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  app.post = (route, values, cookie, headers = {}) => fetch(`${app.origin}${route}`, {
    method: 'POST', redirect: 'manual', headers: { Origin: app.origin, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: new URLSearchParams(values),
  });
  app.setup = async () => {
    const { code } = JSON.parse(await readFile(path.join(data, 'setup.json')));
    const response = await app.post('/setup', { code, name: 'owner', password });
    assert.equal(response.status, 302, await response.text());
    return response.headers.get('set-cookie').split(';')[0];
  };
  app.login = async (name = 'owner', secret = password) => {
    const response = await app.post('/login', { name, password: secret });
    assert.equal(response.status, 302, await response.text());
    return response.headers.get('set-cookie').split(';')[0];
  };
  app.api = async (route, cookie, body, method = body ? 'POST' : 'GET') => {
    const response = await fetch(`${app.origin}${route}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  t.after(async () => { await app.stop(); await rm(data, { recursive: true, force: true }); });
  await app.start(); return app;
}

test('passwords are salted, bounded, and checked without storing plaintext', async () => {
  const a = await passwordHash(password), b = await passwordHash(password);
  assert.notEqual(a, b); assert.ok(!a.includes(password));
  assert.equal(await passwordMatches(password, a), true);
  assert.equal(await passwordMatches('wrong password', a), false);
  assert.equal(await passwordMatches(password, null), false);
  await assert.rejects(passwordHash('short'), { status: 400 });
  await assert.rejects(passwordHash('x'.repeat(257)), { status: 400 });
});

test('fresh install needs its private setup link, survives restart, and cannot be claimed twice', async t => {
  const app = await instance(t, { YEET_INSECURE_COOKIE: '0' });
  const { code } = JSON.parse(await readFile(path.join(app.data, 'setup.json')));
  assert.equal((await app.get('/setup')).status, 400);
  const setupPage = await app.get(`/setup?code=${code}`);
  assert.equal(setupPage.status, 200);
  assert.equal(setupPage.headers.get('referrer-policy'), 'strict-origin', 'HTML form POSTs need a non-null Origin without leaking link secrets');
  assert.equal(setupPage.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal((await app.post('/setup', { code: 'wrong', name: 'thief', password })).status, 400);
  assert.equal((await app.post('/setup', { code, name: 'owner', password: 'short' })).status, 400);
  await app.stop(); await app.start();
  assert.equal(JSON.parse(await readFile(path.join(app.data, 'setup.json'))).code, code);
  const results = await Promise.all([app.post('/setup', { code, name: 'owner', password }), app.post('/setup', { code, name: 'other', password })]);
  assert.deepEqual(results.map(r => r.status).sort(), [302, 400]);
  const response = results.find(r => r.status === 302);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
  assert.equal((await app.get(`/setup?code=${code}`)).status, 400);
  const stored = JSON.parse(await readFile(path.join(app.data, 'members.json')));
  assert.equal(stored.members.length, 1); assert.equal(stored.setupHash, undefined);
  assert.equal(stored.members[0].role, 'admin');
  assert.ok(!JSON.stringify(stored).includes(password));
  await assert.rejects(readFile(path.join(app.data, 'setup.json')), { code: 'ENOENT' });
});

test('password login on a new browser returns to terminal approval and remembers sessions across restart', async t => {
  const app = await instance(t); await app.setup();
  const device = await app.api('/api/device', null, { device: 'laptop' });
  const dest = `/devices/add?code=${device.userCode}`;
  const redirect = await app.get(dest);
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `/login?next=${encodeURIComponent(dest)}`);
  const response = await app.post('/login', { name: 'owner', password, next: dest });
  assert.equal(response.headers.get('location'), dest);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.post('/devices/add', { code: device.userCode, action: 'add' }, cookie)).status, 200);
  const token = (await app.api(`/api/device/${device.code}`)).token;
  assert.ok(token);
  assert.match(await (await app.get('/connect', cookie)).text(), new RegExp(`yeet login ${app.origin}`));
  await app.stop(); await app.start();
  assert.equal((await app.get('/api/me', cookie)).status, 200);
  assert.equal((await app.post('/login', { name: 'owner', password: 'wrong password' })).status, 401);
  assert.equal((await app.post('/login', { name: 'unknown', password })).status, 401);
  assert.equal((await app.post('/login', { name: 'owner', password, next: '//evil.test' })).headers.get('location'), '/');
});

test('invitations are browser-managed, only POST consumes them, and members cannot invite', async t => {
  const app = await instance(t); const owner = await app.setup();
  const page = await app.post('/people', { name: 'alice' }, owner);
  assert.equal(page.status, 200);
  const html = await page.text();
  const link = /href="([^"]+\/join\?code=[^"]+)"/.exec(html)[1];
  const route = new URL(link).pathname + new URL(link).search;
  const code = new URL(link).searchParams.get('code');
  for (let i = 0; i < 2; i++) assert.equal((await app.get(route)).status, 200);
  assert.equal((await app.get(route, owner)).status, 409);
  assert.equal((await app.post('/join', { code, password: 'short' })).status, 400);
  const joined = await app.post('/join', { code, password });
  assert.equal(joined.status, 302);
  const alice = joined.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.get(route)).status, 400);
  assert.equal((await app.post('/join', { code, password })).status, 400);
  assert.equal((await app.get('/people', alice)).status, 403);
  assert.equal((await app.post('/people', { name: 'mallory' }, alice)).status, 403);
  assert.equal((await app.get('/api/me', await app.login('alice'))).status, 200);
});

test('password change and recovery revoke browsers and terminals; old passwords stop working', async t => {
  const app = await instance(t); const first = await app.setup(); const second = await app.login();
  const minted = await app.api('/api/members/owner/tokens', first, { device: 'agent' });
  assert.equal((await app.post('/account', { current: 'incorrect', password: 'a different password' }, first)).status, 401);
  const changed = await app.post('/account', { current: password, password: 'a different password' }, first);
  assert.equal(changed.status, 200);
  const current = changed.headers.get('set-cookie').split(';')[0];
  assert.equal((await app.get('/api/me', second)).status, 401);
  assert.equal((await app.get('/api/me', current)).status, 200);
  assert.equal((await fetch(`${app.origin}/api/me`, { headers: { Authorization: `Bearer ${minted.token}` } })).status, 401);
  assert.equal((await app.post('/login', { name: 'owner', password })).status, 401);
  await app.stop();
  const link = await recoveryLink({ ...app.env, YEET_ORIGIN: app.origin });
  await app.start();
  const reset = await app.post('/join', { code: new URL(link).searchParams.get('code'), password });
  assert.equal(reset.status, 302);
  assert.equal((await app.get('/api/me', current)).status, 401);
  assert.equal((await app.get('/api/me', await app.login())).status, 200);
});

test('legacy installations set a password without losing artifacts, tokens, or identity', async t => {
  const app = await instance(t, { YEET_ADMIN_TOKEN: 'legacy-test-token' });
  const login = await app.post('/login/token', { token: 'legacy-test-token' });
  const oldCookie = login.headers.get('set-cookie').split(';')[0];
  const created = await app.api('/api/artifacts', oldCookie, { name: 'Preserve me' });
  const changed = await app.post('/account', { password }, oldCookie);
  assert.equal(changed.status, 200);
  assert.equal((await app.get('/api/me', oldCookie)).status, 200);
  assert.equal((await fetch(`${app.origin}/api/me`, { headers: { Authorization: 'Bearer legacy-test-token' } })).status, 200);
  const cookie = await app.login('admin');
  assert.equal((await app.get(`/api/artifacts/${created.id}`, cookie)).status, 200);
  assert.equal((await app.get('/setup?code=anything')).status, 400);
});

test('account forms reject cross-origin and opaque-origin requests', async t => {
  const app = await instance(t); const cookie = await app.setup();
  for (const route of ['/login', '/account', '/people']) {
    const values = { name: 'owner', password, current: password };
    for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
      assert.equal((await app.post(route, values, route === '/login' ? null : cookie, headers)).status, 403);
    }
  }
  const response = await fetch(`${app.origin}/login`, { method: 'POST', body: new URLSearchParams({ name: 'owner', password }), redirect: 'manual' });
  assert.equal(response.status, 403);
  assert.equal((await app.post('/devices/add', { code: 'ABCD-EFGH', action: 'add' }, cookie, { Origin: 'null' })).status, 403);
});

test('login throttle ignores forged forwarding headers unless explicitly trusted', async t => {
  const app = await instance(t); await app.setup();
  // Oversized passwords fail cheaply but still consume the per-client attempt budget.
  for (let i = 0; i < 19; i++) assert.equal((await app.post('/login', { name: 'owner', password: 'x'.repeat(257) }, null, { 'X-Forwarded-For': `192.0.2.${i}` })).status, 401);
  assert.equal((await app.post('/login', { name: 'owner', password })).status, 429);
  const throttle = loginThrottle();
  for (let i = 0; i < 20; i++) throttle('one');
  assert.throws(() => throttle('one'), { status: 429 });
  assert.doesNotThrow(() => throttle('two'));
});

test('expired and superseded invites cannot set a password', async t => {
  const app = await instance(t); const owner = await app.setup();
  const first = await app.api('/api/members', owner, { name: 'alice' });
  const second = await app.api('/api/members/alice/invite', owner, {});
  assert.equal((await app.get(new URL(first.inviteUrl).pathname + new URL(first.inviteUrl).search)).status, 400);
  await app.stop();
  const file = path.join(app.data, 'members.json');
  const stored = JSON.parse(await readFile(file)); stored.invites[0].expiresAt = '2000-01-01T00:00:00Z';
  await writeFile(file, JSON.stringify(stored)); await app.start();
  assert.equal((await app.post('/join', { code: new URL(second.inviteUrl).searchParams.get('code'), password })).status, 400);
});

test('browser commands pass URLs as a single argument without shell expansion', () => {
  const url = 'https://yeet.example/devices/add?code=ABCD-EFGH';
  assert.deepEqual(browserCommand(url, 'win32'), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]);
  assert.deepEqual(browserCommand(url, 'darwin'), ['open', [url]]);
  assert.deepEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
});
