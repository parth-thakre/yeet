import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverEntry = path.join(root, 'server', 'server.mjs');
const adminToken = 'device-test-admin-token';

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
    env: { ...process.env, YEET_DATA: data, YEET_PORT: String(port), YEET_ORIGIN: origin, YEET_ADMIN_TOKEN: adminToken, YEET_INSECURE_COOKIE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  t.after(async () => { if (child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed; } });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/healthz`)).ok) return { origin, child, log: () => output }; } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${output}`);
}
const form = body => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
async function jsonRequest(origin, route, { token, cookie, method = 'GET', body, expected = 200 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route}: ${text}`);
  return text ? JSON.parse(text) : null;
}

test('device-code login, invites, per-device tokens, and legacy migration', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-device-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { origin } = await startServer(t, path.join(directory, 'data'));
  const adminCookie = (await fetch(`${origin}/login?token=${adminToken}&next=/`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];

  await t.test('approve flow hands the CLI a token exactly once and lists the device', async () => {
    const begun = await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: 'thinkpad' }, expected: 201 });
    assert.match(begun.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(begun.verifyUrl, `${origin}/devices/add?code=${begun.userCode}`);
    assert.ok(begun.code.length >= 20);
    assert.deepEqual(await jsonRequest(origin, `/api/device/${begun.code}`), { status: 'pending' });
    // Approval page requires a logged-in browser.
    const anonymous = await fetch(`${origin}/devices/add?code=${begun.userCode}`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get('location'), /^\/login\?next=/);
    const page = await fetch(`${origin}/devices/add?code=${begun.userCode}`, { headers: { Cookie: adminCookie } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /thinkpad/);
    // Lower-case and unformatted codes are accepted on the form.
    const approved = await fetch(`${origin}/devices/add`, { ...form({ code: begun.userCode.toLowerCase().replace('-', ''), action: 'add' }), headers: { Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /Terminal connected/);
    const result = await jsonRequest(origin, `/api/device/${begun.code}`);
    assert.equal(result.status, 'approved');
    assert.equal(result.member, 'admin');
    assert.deepEqual(await jsonRequest(origin, '/api/me', { token: result.token }), { name: 'admin', role: 'admin' });
    assert.equal((await jsonRequest(origin, `/api/device/${begun.code}`)).token, result.token, 'a retry inside the grace window returns the same token');
    const { tokens } = await jsonRequest(origin, '/api/tokens', { token: result.token });
    const mine = tokens.find(entry => entry.device === 'thinkpad');
    assert.ok(mine && mine.member === 'admin' && !('tokenHash' in mine));
    assert.ok(tokens.some(entry => entry.device === 'bootstrap'));
    await jsonRequest(origin, `/api/tokens/${mine.id}`, { method: 'DELETE', token: adminToken });
    await jsonRequest(origin, '/api/me', { token: result.token, expected: 401 });
  });

  await t.test('deny, unknown, and malformed codes', async () => {
    const begun = await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: 'agent-box' }, expected: 201 });
    const denied = await fetch(`${origin}/devices/add`, { ...form({ code: begun.userCode, action: 'deny' }), headers: { Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(denied.status, 200);
    assert.deepEqual(await jsonRequest(origin, `/api/device/${begun.code}`), { status: 'denied' });
    await jsonRequest(origin, `/api/device/${begun.code}`, { expected: 404 });
    const unknown = await fetch(`${origin}/devices/add`, { ...form({ code: 'ZZZZ-ZZZZ', action: 'add' }), headers: { Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(unknown.status, 404);
    await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: '' }, expected: 400 });
    await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: 'x'.repeat(65) }, expected: 400 });
    await jsonRequest(origin, '/api/device/not-a-real-poll-code-at-all', { expected: 404 });
  });

  await t.test('invite links log a browser in once; admin can mint and revoke device tokens', async () => {
    const alice = await jsonRequest(origin, '/api/members', { method: 'POST', body: { name: 'alice' }, token: adminToken, expected: 201 });
    assert.ok(alice.inviteUrl.startsWith(`${origin}/join?code=`));
    assert.ok(Date.parse(alice.expiresAt) > Date.now());
    const bad = await fetch(`${origin}/join?code=wrong`, { redirect: 'manual' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(alice.inviteUrl, { redirect: 'manual' })).status, 200, 'GET does not consume an invite');
    const joined = await fetch(`${origin}/join`, { ...form({ code: new URL(alice.inviteUrl).searchParams.get('code'), password: 'alice-test-password' }), headers: { Origin: origin }, redirect: 'manual' });
    assert.equal(joined.status, 302);
    assert.equal(joined.headers.get('location'), '/');
    const aliceCookie = joined.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await jsonRequest(origin, '/api/me', { cookie: aliceCookie }), { name: 'alice', role: 'member' });
    assert.equal((await fetch(alice.inviteUrl, { redirect: 'manual' })).status, 400, 'single use');
    // Members cannot mint or invite; admin can reissue an invite and mint a token for a headless agent.
    await jsonRequest(origin, '/api/members/alice/invite', { method: 'POST', cookie: aliceCookie, expected: 403 });
    const again = await jsonRequest(origin, '/api/members/alice/invite', { method: 'POST', token: adminToken, expected: 201 });
    assert.notEqual(again.inviteUrl, alice.inviteUrl);
    assert.equal((await fetch(again.inviteUrl, { redirect: 'manual' })).status, 200);
    const minted = await jsonRequest(origin, '/api/members/alice/tokens', { method: 'POST', body: { device: 'ci-runner' }, token: adminToken, expected: 201 });
    assert.deepEqual(await jsonRequest(origin, '/api/me', { token: minted.token }), { name: 'alice', role: 'member' });
    await jsonRequest(origin, '/api/members/nobody/tokens', { method: 'POST', body: { device: 'x' }, token: adminToken, expected: 404 });
    // Alice sees only her own devices and can revoke one; admin sees all.
    const hers = (await jsonRequest(origin, '/api/tokens', { token: minted.token })).tokens;
    assert.ok(hers.every(entry => entry.member === 'alice'));
    const all = (await jsonRequest(origin, '/api/tokens', { token: adminToken })).tokens;
    assert.ok(all.some(entry => entry.member === 'admin') && all.some(entry => entry.member === 'alice'));
    // Approving a device from Alice's phone binds the token to Alice.
    const begun = await jsonRequest(origin, '/api/device', { method: 'POST', body: { device: 'alice-laptop' }, expected: 201 });
    await fetch(`${origin}/devices/add`, { ...form({ code: begun.userCode, action: 'add' }), headers: { Cookie: aliceCookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
    const polled = await jsonRequest(origin, `/api/device/${begun.code}`);
    assert.equal(polled.member, 'alice');
    // Removing the member kills tokens, sessions, and invites together.
    const third = await jsonRequest(origin, '/api/members/alice/invite', { method: 'POST', token: adminToken, expected: 201 });
    await jsonRequest(origin, '/api/members/alice', { method: 'DELETE', token: adminToken });
    await jsonRequest(origin, '/api/me', { token: minted.token, expected: 401 });
    await jsonRequest(origin, '/api/me', { token: polled.token, expected: 401 });
    await jsonRequest(origin, '/api/me', { cookie: aliceCookie, expected: 401 });
    assert.equal((await fetch(third.inviteUrl, { redirect: 'manual' })).status, 400);
  });
});

test('a v1 members.json with per-member tokens is migrated on start and keeps working', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const data = path.join(directory, 'data');
  await mkdir(data, { recursive: true });
  const { createHash } = await import('node:crypto');
  const legacyToken = 'legacy-member-token';
  await writeFile(path.join(data, 'members.json'), JSON.stringify({ members: [
    { name: 'admin', tokenHash: createHash('sha256').update(adminToken).digest('hex'), role: 'admin', createdAt: '2026-09-18T00:00:00.000Z', revokedAt: null },
    { name: 'legacy', tokenHash: createHash('sha256').update(legacyToken).digest('hex'), role: 'member', createdAt: '2026-09-18T00:00:00.000Z', revokedAt: null },
  ] }));
  const { origin } = await startServer(t, data);
  assert.deepEqual(await jsonRequest(origin, '/api/me', { token: legacyToken }), { name: 'legacy', role: 'member' });
  assert.deepEqual(await jsonRequest(origin, '/api/me', { token: adminToken }), { name: 'admin', role: 'admin' });
  const stored = JSON.parse(await readFile(path.join(data, 'members.json'), 'utf8'));
  assert.ok(stored.members.every(member => !('tokenHash' in member)));
  assert.equal(stored.tokens.filter(entry => entry.device === 'legacy').length, 2);
  const { tokens } = await jsonRequest(origin, '/api/tokens', { token: adminToken });
  assert.ok(tokens.some(entry => entry.member === 'legacy' && entry.device === 'legacy'));
});

test('the /devices page lists devices and revokes one from the browser', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-devpage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { origin } = await startServer(t, path.join(directory, 'data'));
  const cookie = (await fetch(`${origin}/login?token=${adminToken}&next=/`, { redirect: 'manual' })).headers.get('set-cookie').split(';')[0];
  const minted = await jsonRequest(origin, '/api/members/admin/tokens', { method: 'POST', body: { device: 'old-laptop' }, token: adminToken, expected: 201 });
  assert.equal((await fetch(`${origin}/devices`, { redirect: 'manual' })).status, 302, 'anonymous is sent to login');
  const listing = await fetch(`${origin}/devices`, { headers: { Cookie: cookie } });
  assert.equal(listing.status, 200);
  const html = await listing.text();
  assert.match(html, /old-laptop/);
  assert.match(html, new RegExp(`/devices/${minted.id}/revoke`));
  const revoked = await fetch(`${origin}/devices/${minted.id}/revoke`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(revoked.status, 302);
  assert.equal(revoked.headers.get('location'), '/devices');
  await jsonRequest(origin, '/api/me', { token: minted.token, expected: 401 });
  assert.doesNotMatch(await (await fetch(`${origin}/devices`, { headers: { Cookie: cookie } })).text(), /old-laptop/);
  assert.equal((await fetch(`${origin}/devices/${minted.id}/revoke`, { method: 'POST', headers: { Cookie: cookie }, redirect: 'manual' })).status, 404, 'already revoked');
});
