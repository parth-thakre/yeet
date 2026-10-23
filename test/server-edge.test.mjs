import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from '../server/server.mjs';

const admin = 'edge-tests-admin-token';
async function fixture(t) {
  t.mock.method(console, 'log', () => {});
  const data = await mkdtemp(path.join(tmpdir(), 'yeet-edge-'));
  const env = { YEET_DATA: data, YEET_PORT: '0', YEET_ADMIN_TOKEN: admin };
  const servers = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(data, { recursive: true, force: true, maxRetries: 5 });
  });
  async function start(overrides = {}) {
    const { server } = await createServer({ ...env, ...overrides });
    servers.push(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function request(url, options = {}) {
      return fetch(origin + url, { redirect: 'manual', ...options, headers: { Authorization: `Bearer ${admin}`, ...options.headers } });
    }
    async function json(url, options = {}, expected = 200) {
      const response = await request(url, options);
      assert.equal(response.status, expected, await response.clone().text());
      return response.json();
    }
    return { server, request, json };
  }
  return { data, start, ...await start() };
}
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

test('file count and streamed byte limits preserve existing uploads', { timeout: 120000 }, async t => {
  const { data, request, json } = await fixture(t);
  const { id } = await json('/api/artifacts', post({}), 201);
  const route = `/api/artifacts/${id}/versions`;
  const { n } = await json(route, post({ entry: 'index.html' }), 201);
  const pending = path.join(data, 'artifacts', id, `v${n}.pending`);
  await json(`${route}/${n}/files/index.html`, { method: 'PUT', body: '<h1>Keep this</h1>' }, 201);
  // Seed tiny files to exercise the boundary without 499 redundant HTTP uploads.
  await Promise.all(Array.from({ length: 499 }, (_, i) => writeFile(path.join(pending, `file-${i}.txt`), '')));
  const rejected = await request(`${route}/${n}/files/extra.txt`, { method: 'PUT', body: 'over the limit' });
  assert.equal(rejected.status, 413); await rejected.text();
  await json(`${route}/${n}/files/file-0.txt`, { method: 'PUT', body: 'replacement' }, 201);
  const chunk = Buffer.alloc(1024 * 1024, 65);
  async function* tooLarge() { for (let i = 0; i < 201; i++) yield chunk; }
  const oversized = await request(`${route}/${n}/files/index.html`, {
    method: 'PUT', body: Readable.from(tooLarge()), duplex: 'half', signal: AbortSignal.timeout(90000),
  });
  assert.equal(oversized.status, 413); await oversized.text();
  assert.equal(await readFile(path.join(pending, 'index.html'), 'utf8'), '<h1>Keep this</h1>');
  assert.equal((await readdir(pending)).filter(name => name.startsWith('.upload-')).length, 0);
  await json(`${route}/${n}/commit`, { method: 'POST' });
  const visible = await request(`/a/${id}/`);
  assert.equal(visible.status, 200); assert.equal(await visible.text(), '<h1>Keep this</h1>');
});

test('sessions survive restart; bootstrap token is ignored after first start', async t => {
  const fixtureState = await fixture(t);
  const { data, server, request, start } = fixtureState;
  const login = await request(`/login?token=${admin}`);
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /; Secure/);
  const members = await readFile(path.join(data, 'members.json'), 'utf8');
  const sessions = await readFile(path.join(data, 'sessions.json'), 'utf8');
  assert.ok(!members.includes(admin)); assert.ok(!sessions.includes(cookie.split(';')[0].split('=')[1]));
  await new Promise(resolve => server.close(resolve));
  const restarted = await start({ YEET_ADMIN_TOKEN: 'must-not-replace-existing-token' });
  assert.equal((await restarted.request('/api/me')).status, 200);
  assert.equal((await restarted.request('/api/me', { headers: { Authorization: 'Bearer must-not-replace-existing-token' } })).status, 401);
  const session = await fetch(`http://127.0.0.1:${restarted.server.address().port}/api/me`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(session.status, 200); assert.equal((await session.json()).name, 'admin');
});

test('ustar prefix names, directory index, empty files and HEAD', async t => {
  const { request, json } = await fixture(t);
  const { id } = await json('/api/artifacts', post({ visibility: 'public' }), 201);
  const route = `/api/artifacts/${id}/versions`;
  const { n } = await json(route, post({ entry: 'index.html' }), 201);
  const longPath = `${'x'.repeat(80)}/${'y'.repeat(80)}.txt`;
  for (const [file, body] of [['index.html', '<h1>Hello</h1>'], ['docs/index.html', '<p>Directory index</p>'], ['empty.txt', ''], [longPath, 'long path']]) {
    await json(`${route}/${n}/files/${file}`, { method: 'PUT', body }, 201);
  }
  await json(`${route}/${n}/commit`, { method: 'POST' });
  const directory = await request(`/a/${id}/docs/`);
  assert.equal(await directory.text(), '<p>Directory index</p>');
  const empty = await request(`/a/${id}/empty.txt`);
  assert.equal(empty.status, 200); assert.equal(await empty.text(), '');
  const range = await request(`/a/${id}/empty.txt`, { headers: { Range: 'bytes=0-' } });
  assert.equal(range.status, 416); assert.equal(range.headers.get('content-range'), 'bytes */0'); await range.text();
  const tar = await request(`${route}/${n}/files.tar`);
  const buffer = Buffer.from(await tar.arrayBuffer());
  const names = [];
  for (let offset = 0; buffer[offset];) {
    const header = buffer.subarray(offset, offset + 512);
    const text = (a, b) => header.subarray(a, b).toString().split(String.fromCharCode(0))[0];
    names.push([text(345, 500), text(0, 100)].filter(Boolean).join('/'));
    offset += 512 + Math.ceil(parseInt(text(124, 136), 8) / 512) * 512;
  }
  assert.ok(names.includes(longPath));
  const head = await request(`${route}/${n}/files.tar`, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), buffer.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('a browser session changes state only from this origin; bearer clients are unaffected', async t => {
  const { server, request, json } = await fixture(t);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await request(`/login?token=${admin}`)).headers.get('set-cookie').split(';')[0];
  const create = headers => fetch(`${origin}/api/artifacts`, { method: 'POST', body: '{}', headers: { Cookie: cookie, ...headers } });
  // A sibling origin on the same site still gets the SameSite=Lax cookie, even with a no-cors text/plain post.
  for (const headers of [{ 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'http://127.0.0.1:1', 'Content-Type': 'text/plain' }]) {
    const refused = await create(headers);
    assert.equal(refused.status, 403, JSON.stringify(headers)); await refused.text();
  }
  assert.equal((await json('/api/artifacts')).artifacts.length, 0, 'nothing was created');
  const allowed = await create({ 'Sec-Fetch-Site': 'same-origin', Origin: origin });
  assert.equal(allowed.status, 201); await allowed.text();
  const read = await fetch(`${origin}/api/me`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(read.status, 200, 'reads are not state changes'); await read.text();
  await json('/api/artifacts', { ...post({}), headers: { 'Sec-Fetch-Site': 'cross-site' } }, 201);
});

test('an abandoned upload stops blocking once idle, and only the owner sees it', async t => {
  const { data, server, request, json, start } = await fixture(t);
  const { id } = await json('/api/artifacts', post({ visibility: 'public' }), 201);
  const route = `/api/artifacts/${id}/versions`;
  const dir = n => path.join(data, 'artifacts', id, `v${n}.pending`);
  const idle = async n => { const old = new Date(Date.now() - 31 * 60 * 1000); await utimes(dir(n), old, old); };
  assert.equal((await json(route, post({ entry: 'index.html' }), 201)).n, 1);
  assert.equal((await json(`/api/artifacts/${id}`)).pending, 1);
  const anonymous = await (await fetch(`http://127.0.0.1:${server.address().port}/api/artifacts/${id}`)).json();
  assert.equal(anonymous.pending, undefined, 'readers who cannot upload never see pending state');
  assert.match((await json(route, post({ entry: 'index.html' }), 409)).error, /Version 1 is already pending/);
  // The CLI was killed after begin; half an hour later a new throw takes over under a fresh number.
  await idle(1);
  assert.equal((await json(route, post({ entry: 'index.html' }), 201)).n, 2);
  assert.deepEqual((await readdir(path.join(data, 'artifacts', id))).filter(name => name.endsWith('.pending')), ['v2.pending']);
  await json(`${route}/1/files/index.html`, { method: 'PUT', body: 'stale client' }, 404);
  // Each finished file counts as progress, so a slow upload in progress keeps its claim.
  await idle(2);
  await json(`${route}/2/files/index.html`, { method: 'PUT', body: '<h1>two</h1>' }, 201);
  await json(route, post({ entry: 'index.html' }), 409);
  await json(`${route}/2/commit`, { method: 'POST' });
  const detail = await json(`/api/artifacts/${id}`);
  assert.equal(detail.pending, null);
  assert.equal(detail.allocated, undefined, 'bookkeeping stays on the server');
  // No number is handed out twice, across an abandon and a restart, so the client that held v1 never gets it back.
  assert.equal((await json(route, post({ entry: 'index.html' }), 201)).n, 3);
  assert.equal((await request(`${route}/3`, { method: 'DELETE' })).status, 204);
  const restarted = await start();
  assert.equal((await restarted.json(route, post({ entry: 'index.html' }), 201)).n, 4);
});

test('the server binds loopback unless YEET_HOST says otherwise', async t => {
  t.mock.method(console, 'log', () => {});
  const data = await mkdtemp(path.join(tmpdir(), 'yeet-host-'));
  t.after(() => rm(data, { recursive: true, force: true, maxRetries: 5 }));
  assert.equal((await createServer({ YEET_DATA: data, YEET_PORT: '0' })).host, '127.0.0.1');
  assert.equal((await createServer({ YEET_DATA: data, YEET_PORT: '0', YEET_HOST: '0.0.0.0' })).host, '0.0.0.0');
});
