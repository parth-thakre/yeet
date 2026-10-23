import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { qrMatrix, qrTerminal } from '../cli/qr.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const serverEntry = path.join(root, 'server', 'server.mjs');
const cli = path.join(root, 'cli', 'yeet.mjs');
const adminToken = 'browser-link-admin-token';
const direct = { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' };

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
    try { if ((await fetch(`${origin}/healthz`)).ok) return { origin, log: () => output }; } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
    await delay(50);
  }
  throw new Error(`server did not start: ${output}`);
}
async function api(origin, route, { token, cookie, method = 'GET', body, expected = 200 } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${origin}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await response.text();
  assert.equal(response.status, expected, `${method} ${route}: ${text}`);
  return text ? JSON.parse(text) : null;
}
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
// fetch() overwrites Sec-Fetch-Mode with "cors", so browser navigations are sent with node:http.
function visit(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => {
      let text = '';
      response.setEncoding('utf8').on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: { get: name => [].concat(response.headers[name.toLowerCase()] ?? null).join(', ') || null }, text: async () => text }));
    }).on('error', reject);
  });
}

test('a connected terminal signs browsers in with one-time links', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-browser-link-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { origin, log } = await startServer(t, path.join(directory, 'data'));
  const laptop = await api(origin, '/api/members/admin/tokens', { method: 'POST', body: { device: 'test-laptop' }, token: adminToken, expected: 201 });
  const mint = (next = '/', token = laptop.token) => api(origin, '/api/browser-links', { method: 'POST', body: { next }, token, expected: 201 });

  await t.test('only a device token can mint a link', async () => {
    const link = await mint();
    assert.equal(link.member, 'admin');
    assert.equal(link.device, 'test-laptop');
    assert.equal(link.expiresIn, 120);
    assert.match(link.code, /^[A-Za-z0-9_-]{43}$/);
    await api(origin, '/api/browser-links', { method: 'POST', body: {}, expected: 401 });
    await api(origin, '/api/browser-links', { method: 'POST', body: {}, token: 'not-a-token', expected: 401 });
    const session = (await visit(`${origin}/login/link?code=${link.code}`, direct)).headers.get('set-cookie').split(';')[0];
    await api(origin, '/api/browser-links', { method: 'POST', body: {}, cookie: session, expected: 401 });
  });

  await t.test('direct navigation signs in once and lands on the requested page', async () => {
    const link = await mint('/devices');
    const signed = await visit(`${origin}/login/link?code=${link.code}`, direct);
    assert.equal(signed.status, 302);
    assert.equal(signed.headers.get('location'), '/devices');
    const cookie = signed.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await api(origin, '/api/me', { cookie }), { name: 'admin', role: 'admin' });
    const again = await visit(`${origin}/login/link?code=${link.code}`, direct);
    assert.equal(again.status, 400);
    assert.equal(again.headers.get('set-cookie'), null);
    assert.doesNotMatch(log(), new RegExp(link.code), 'codes never reach the request log');
  });

  await t.test('previews and cross-site visits get a confirmation instead of a session', async () => {
    const link = await mint();
    const preview = await visit(`${origin}/login/link?code=${link.code}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('set-cookie'), null);
    const html = await preview.text();
    assert.match(html, /admin/);
    assert.match(html, /test-laptop/);
    const crossSite = await visit(`${origin}/login/link?code=${link.code}`, { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' });
    assert.equal(crossSite.headers.get('set-cookie'), null);
    const forged = await fetch(`${origin}/login/link`, { method: 'POST', redirect: 'manual', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: link.code }) });
    assert.equal(forged.status, 403);
    const confirmed = await fetch(`${origin}/login/link`, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: link.code }) });
    assert.equal(confirmed.status, 302);
    assert.ok(confirmed.headers.get('set-cookie'));
  });

  await t.test('unsafe next paths fall back to the workspace', async () => {
    const link = await mint('//evil.example/');
    assert.equal((await visit(`${origin}/login/link?code=${link.code}`, direct)).headers.get('location'), '/');
  });

  await t.test('revoking the terminal signs its browsers out and voids pending links', async () => {
    const other = await api(origin, '/api/members/admin/tokens', { method: 'POST', body: { device: 'old-desktop' }, token: adminToken, expected: 201 });
    const used = await mint('/', other.token);
    const pending = await mint('/', other.token);
    const cookie = (await visit(`${origin}/login/link?code=${used.code}`, direct)).headers.get('set-cookie').split(';')[0];
    await api(origin, '/api/me', { cookie });
    await api(origin, `/api/tokens/${other.id}`, { method: 'DELETE', token: adminToken });
    await api(origin, '/api/me', { cookie, expected: 401 });
    assert.equal((await visit(`${origin}/login/link?code=${pending.code}`, direct)).status, 400);
  });

  await t.test('a session from a revoked terminal stops working even if pruning was missed', async () => {
    const other = await api(origin, '/api/members/admin/tokens', { method: 'POST', body: { device: 'racing-desktop' }, token: adminToken, expected: 201 });
    const cookie = (await visit(`${origin}/login/link?code=${(await mint('/', other.token)).code}`, direct)).headers.get('set-cookie').split(';')[0];
    // Simulate a revocation that finished between redemption and session creation: the token is
    // revoked on disk but its session record survives.
    const file = path.join(directory, 'data', 'members.json');
    const stored = JSON.parse(await readFile(file, 'utf8'));
    stored.tokens.find(entry => entry.id === other.id).revokedAt = new Date().toISOString();
    await writeFile(file, JSON.stringify(stored));
    await api(origin, '/api/me', { cookie, expected: 401 });
  });

  await t.test('a browser signed in as someone else is asked before switching', async () => {
    await api(origin, '/api/members', { method: 'POST', body: { name: 'alice' }, token: adminToken, expected: 201 });
    const alice = await api(origin, '/api/members/alice/tokens', { method: 'POST', body: { device: 'alice-laptop' }, token: adminToken, expected: 201 });
    const adminCookie = (await visit(`${origin}/login/link?code=${(await mint()).code}`, direct)).headers.get('set-cookie').split(';')[0];
    const link = await mint('/', alice.token);
    const asked = await visit(`${origin}/login/link?code=${link.code}`, { ...direct, Cookie: adminCookie });
    assert.equal(asked.status, 200);
    assert.equal(asked.headers.get('set-cookie'), null);
    const html = await asked.text();
    assert.match(html, /signed in as <strong>admin<\/strong>/);
    assert.match(html, /Switch to alice/);
    assert.deepEqual(await api(origin, '/api/me', { cookie: adminCookie }), { name: 'admin', role: 'admin' }, 'still admin until confirmed');
    const confirmed = await fetch(`${origin}/login/link`, { method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: adminCookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: link.code }) });
    assert.equal(confirmed.status, 302);
    const aliceCookie = confirmed.headers.get('set-cookie').split(';')[0];
    assert.deepEqual(await api(origin, '/api/me', { cookie: aliceCookie }), { name: 'alice', role: 'member' });
    await api(origin, '/api/me', { cookie: adminCookie, expected: 401 });
    const same = await visit(`${origin}/login/link?code=${(await mint('/devices', alice.token)).code}`, { ...direct, Cookie: aliceCookie });
    assert.equal(same.headers.get('location'), '/devices', 'the same person is signed in without asking');
  });

  await t.test('yeet open prints a working link or a QR code and checks the origin', async () => {
    const env = { YEET_HOME: path.join(directory, 'home'), YEET_ORIGIN: origin, YEET_TOKEN: laptop.token };
    const printed = await run(['open', '--no-browser', `${origin}/devices`], env);
    assert.equal(printed.code, 0, printed.stderr);
    const url = printed.stdout.trim();
    assert.match(url, new RegExp(`^${origin}/login/link\\?code=[A-Za-z0-9_-]{43}$`));
    assert.match(printed.stderr, /works once/);
    assert.equal((await visit(url, direct)).headers.get('location'), '/devices');
    const id = await run(['open', '--no-browser', 'abcdefghijkl'], env);
    assert.equal(id.code, 0, id.stderr);
    assert.equal((await visit(id.stdout.trim(), direct)).headers.get('location'), '/a/abcdefghijkl/');
    const qr = await run(['open', '--qr'], env);
    assert.equal(qr.code, 0, qr.stderr);
    assert.match(qr.stdout, /▀|▄|█/);
    assert.match(qr.stderr, /Scan this with your phone/);
    const foreign = await run(['open', '--no-browser', 'https://other.example/a/abcdefghijkl/'], env);
    assert.equal(foreign.code, 1);
    assert.match(foreign.stderr, /connected to/);
    assert.equal((await run(['open', '--qr', '--no-browser'], env)).code, 1);
    const anonymous = await run(['open', '--no-browser'], { YEET_HOME: path.join(directory, 'nobody'), YEET_ORIGIN: origin, YEET_TOKEN: '' });
    assert.equal(anonymous.code, 2);
  });
});

test('QR codes pick the smallest version and carry finder patterns', () => {
  const url = `https://yeet.example.com/login/link?code=${'x'.repeat(43)}`;
  const matrix = qrMatrix(url);
  assert.equal(matrix.length, 37, 'version 5 fits an 84-byte link at level M');
  assert.equal(qrMatrix('a').length, 21);
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  const read = (x, y) => Array.from({ length: 7 }, (_, dy) => matrix[y + dy].slice(x, x + 7).map(Number).join(''));
  assert.deepEqual(read(0, 0), finder);
  assert.deepEqual(read(30, 0), finder);
  assert.deepEqual(read(0, 30), finder);
  assert.equal(matrix[29][8], true, 'dark module');
  assert.deepEqual(qrMatrix(url), matrix, 'deterministic');
  assert.equal(qrTerminal(url).split('\n').length, Math.ceil((37 + 8) / 2));
});

test('QR matrices match an independent encoder module for module', async () => {
  // Generated with Python's qrcode package (level M, fixed masks), covering versions 1, 5 and 10:
  // single and multi-block error correction, version information, and UTF-8 payloads.
  const fixtures = JSON.parse(await readFile(new URL('./qr-fixtures.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) {
    const rows = qrMatrix(fixture.text, fixture.mask).map(row => row.map(Number).join(''));
    assert.deepEqual(rows, fixture.rows, `version ${fixture.version}`);
  }
});
