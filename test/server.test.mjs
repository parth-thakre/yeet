import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const admin = 'integration-admin-token-not-a-real-secret';
const origin = 'https://yeet.example';
const html = Buffer.from('<!doctype html><h1>Version one</h1><img src="media/image.png"><video controls playsinline src="media/clip.mp4"></video>');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=', 'base64');
const video = Buffer.from('00000018ftypmp4200000000mp42isom0123456789');
const csp = "sandbox allow-scripts allow-same-origin; default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";

async function start(t) {
  const data = await mkdtemp(join(tmpdir(), 'yeet-http-'));
  const child = spawn(process.execPath, ['server/server.mjs'], {
    cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, YEET_DATA: data, YEET_PORT: '0', YEET_ORIGIN: origin,
      YEET_ADMIN_TOKEN: admin, YEET_INSECURE_COOKIE: '1' },
  });
  let output = '';
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    await rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Server startup timed out\n${output}`)), 15000);
    const onError = error => finish(error);
    const onExit = code => finish(new Error(`Server exited ${code}\n${output}`));
    function finish(error, url) {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      error ? reject(error) : resolve(url);
    }
    child.once('error', onError);
    child.once('exit', onExit);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Yeet listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    });
  });
}

function untar(bytes) {
  const entries = new Map();
  let offset = 0;
  for (; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (a, b) => header.subarray(a, b).toString().replace(/\0.*$/s, '');
    assert.equal(text(257, 263), 'ustar');
    assert.equal(text(263, 265), '00');
    const checksum = [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    assert.equal(parseInt(text(148, 156).trim(), 8), checksum, 'tar header checksum');
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/');
    const size = parseInt(text(124, 136).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.ok(offset + 512 + size <= bytes.length, 'complete tar body');
    assert.ok(!name.split('/').some(part => part.startsWith('.')), `unsafe tar path ${name}`);
    if (text(156, 157) !== '5') {
      assert.ok(['', '0'].includes(text(156, 157)), 'only regular files or directories');
      assert.ok(!entries.has(name), 'no duplicate tar entries');
      entries.set(name, bytes.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(bytes.length - offset >= 1024, 'two tar end blocks');
  assert.ok(bytes.subarray(offset).every(byte => byte === 0), 'zero-filled tar end');
  return entries;
}

test('HTTP server contract', { timeout: 60000 }, async t => {
  const base = await start(t);
  async function request(path, { token = admin, headers = {}, ...options } = {}) {
    return fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...options,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } });
  }
  async function status(response, expected) {
    assert.equal(response.status, expected, `${response.url}: ${await response.clone().text()}`);
    return response;
  }
  async function json(path, { method = 'GET', body, expected = 200, ...options } = {}) {
    const response = await status(await request(path, { method, ...options,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), expected);
    assert.match(response.headers.get('content-type'), /^application\/json\b/);
    const result = await response.json();
    if (expected >= 400) assert.equal(typeof result.error, 'string');
    return result;
  }
  async function create(body = {}) {
    const artifact = await json('/api/artifacts', { method: 'POST', body, expected: 201 });
    assert.match(artifact.id, /^[A-Za-z0-9_-]{12}$/);
    assert.equal(artifact.url, `${origin}/a/${artifact.id}`);
    assert.equal(artifact.latest, 0);
    return artifact.id;
  }
  async function begin(id, entry = 'index.html') {
    return (await json(`/api/artifacts/${id}/versions`, { method: 'POST', body: { entry }, expected: 201 })).n;
  }
  async function upload(id, n, path, bytes) {
    const response = await status(await request(`/api/artifacts/${id}/versions/${n}/files/${path}`, { method: 'PUT', body: bytes }), 201);
    assert.deepEqual(await response.json(), { path, bytes: bytes.length });
  }
  async function commit(id, n) {
    const result = await json(`/api/artifacts/${id}/versions/${n}/commit`, { method: 'POST' });
    assert.deepEqual(result, { id, url: `${origin}/a/${id}`, n, latest: n });
  }
  async function published(visibility) {
    const id = await create({ visibility });
    const n = await begin(id);
    await upload(id, n, 'index.html', html);
    await commit(id, n);
    return id;
  }
  let id;
  await t.test('health and authentication', async () => {
    assert.deepEqual(await json('/healthz', { token: null }), { ok: true });
    assert.deepEqual(await json('/api/me'), { name: 'admin', role: 'admin' });
    await json('/api/me', { token: null, expected: 401 });
    await json('/api/me', { token: 'wrong-token', expected: 401 });
    await json('/api/artifacts', { method: 'POST', body: {}, token: null, expected: 401 });
  });
  await t.test('create, upload and commit preserve files and metadata', async () => {
    id = await create({ name: 'HTTP fixture', sourceKey: 'server-test-source' });
    const n = await begin(id);
    assert.equal(n, 1);
    for (const [path, bytes] of [['index.html', html], ['media/image.png', png], ['media/clip.mp4', video]]) await upload(id, n, path, bytes);
    await commit(id, n);
    const meta = await json(`/api/artifacts/${id}`);
    assert.equal(meta.owner, 'admin');
    assert.equal(meta.visibility, 'workspace');
    assert.equal(meta.name, 'HTTP fixture');
    assert.equal(meta.latest, 1);
    assert.equal(meta.versions[0].entry, 'index.html');
    assert.deepEqual(meta.versions[0].files.map(f => [f.path, f.bytes]).sort(), [['index.html', html.length], ['media/image.png', png.length], ['media/clip.mp4', video.length]].sort());
    const found = await json('/api/artifacts?sourceKey=server-test-source');
    assert.deepEqual(found.artifacts.map(a => a.id), [id]);
  });
  await t.test('projects file pages without reordering them and group the workspace page', async () => {
    const filed = await create({ name: 'Filed <page>', project: '  Checkout  ' });
    const n = await begin(filed);
    await upload(filed, n, 'index.html', html);
    await commit(filed, n);
    assert.equal((await json(`/api/artifacts/${filed}`)).project, 'Checkout');
    const before = (await json(`/api/artifacts/${id}`)).updatedAt;
    assert.equal((await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project: 'Billing & <ops>' } })).project, 'Billing & <ops>');
    assert.equal((await json(`/api/artifacts/${id}`)).updatedAt, before, 'filing a page keeps its place in the list');
    for (const project of [42, 'x'.repeat(81), 'two\nlines']) await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project }, expected: 400 });
    await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project: 'Elsewhere', expectedProject: 'Checkout' }, expected: 409 });
    assert.equal((await json(`/api/artifacts/${id}`)).project, 'Billing & <ops>', 'a stale expectation changes nothing');
    assert.equal((await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project: 'Billing & <ops>', expectedProject: ' Billing & <ops> ' } })).project, 'Billing & <ops>');
    const own = (await json('/api/artifacts')).artifacts;
    assert.deepEqual(own.map(a => [a.id, a.project]).sort(), [[filed, 'Checkout'], [id, 'Billing & <ops>']].sort());
    const unfiled = await create({ name: 'Loose page' });
    const workspace = await (await status(await request('/'), 200)).text();
    const headings = [...workspace.matchAll(/<h2>(.*?) <span/g)].map(match => match[1]);
    assert.deepEqual(headings, ['Checkout', 'Billing &amp; &lt;ops&gt;', 'No project'], 'newest project first, unfiled last, names escaped');
    assert.ok(workspace.indexOf(`/a/${unfiled}/`) > workspace.indexOf('No project'));
    assert.match(workspace, /yeet sort/);
    const checkout = await json('/api/projects/Checkout', { method: 'PUT', body: { description: '  Storefront   <checkout> flow ' } });
    assert.deepEqual([checkout.name, checkout.description, checkout.updatedBy], ['Checkout', 'Storefront <checkout> flow', 'admin']);
    assert.equal((await json(`/api/projects/${encodeURIComponent('Billing & <ops>')}`)).description, null);
    assert.match(await (await status(await request('/'), 200)).text(), /<h2>Checkout <span[^>]*>1<\/span><\/h2><p class="detail">Storefront &lt;checkout&gt; flow<\/p>/);
    for (const name of ['__proto__', 'constructor']) {
      assert.equal((await json(`/api/projects/${name}`)).description, null);
      assert.equal((await json(`/api/projects/${name}`, { method: 'PUT', body: { description: `Named ${name}` } })).description, `Named ${name}`);
    }
    for (const name of ['100%', '%41', 'API/UI']) {
      const route = `/api/projects/${encodeURIComponent(name)}`;
      assert.equal((await json(route, { method: 'PUT', body: { description: `About ${name}` } })).name, name);
      assert.equal((await json(route)).description, `About ${name}`, `${name} round-trips through one decode`);
    }
    assert.equal((await json('/api/projects/A')).description, null, '%41 is its own project, not A');
    await json('/api/projects/Checkout', { method: 'PUT', body: { description: 'x'.repeat(281) }, expected: 400 });
    await json('/api/projects/Checkout', { method: 'PUT', body: { description: 7 }, expected: 400 });
    await json('/api/projects/%E0%A4', { expected: 400 });
    await json('/api/projects/Checkout', { token: null, expected: 401 });
    assert.equal((await json('/api/projects/Checkout', { method: 'PUT', body: { description: '' } })).description, null, 'an empty description clears it');
    assert.equal((await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project: null } })).project, null);
  });
  await t.test('artifact redirects, MIME, CSP and cache headers', async () => {
    const redirect = await status(await request(`/a/${id}`), 302);
    assert.equal(new URL(redirect.headers.get('location'), base).pathname, `/a/${id}/`);
    for (const [path, type, bytes] of [['', 'text/html; charset=utf-8', html], ['media/image.png', 'image/png', png], ['media/clip.mp4', 'video/mp4', video]]) {
      const response = await status(await request(`/a/${id}/${path}`), 200);
      assert.equal(response.headers.get('content-type'), type);
      assert.equal(response.headers.get('x-yeet-artifact'), id);
      assert.equal(response.headers.get('x-yeet-version'), '1');
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('cache-control'), 'private, no-cache');
      if (!path) assert.equal(response.headers.get('content-security-policy'), csp);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
  });
  await t.test('video ranges, suffix ranges, invalid ranges and HEAD', async () => {
    for (const [range, first, last] of [['bytes=0-9', 0, 9], ['bytes=2-8', 2, 8], ['bytes=-5', video.length - 5, video.length - 1], ['bytes=10-', 10, video.length - 1]]) {
      const response = await status(await request(`/a/${id}/media/clip.mp4`, { headers: { Range: range } }), 206);
      assert.equal(response.headers.get('content-range'), `bytes ${first}-${last}/${video.length}`);
      assert.equal(response.headers.get('content-length'), String(last - first + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(first, last + 1));
    }
    for (const range of ['bytes=999999-', `bytes=${video.length}-`, 'bytes=9-2']) {
      const response = await status(await request(`/a/${id}/media/clip.mp4`, { headers: { Range: range } }), 416);
      assert.equal(response.headers.get('content-range'), `bytes */${video.length}`);
    }
    const head = await status(await request(`/a/${id}/media/clip.mp4`, { method: 'HEAD' }), 200);
    assert.equal(head.headers.get('content-length'), String(video.length));
    assert.equal(head.headers.get('content-type'), 'video/mp4');
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
  await t.test('rethrow advances latest and pinned links keep original assets', async () => {
    const n = await begin(id);
    assert.equal(n, 2);
    await upload(id, n, 'index.html', Buffer.from('<h1>Version two</h1>'));
    await commit(id, n);
    assert.equal(await (await status(await request(`/a/${id}/`), 200)).text(), '<h1>Version two</h1>');
    const redirect = await status(await request(`/a/${id}/?v=1`), 302);
    assert.equal(new URL(redirect.headers.get('location'), base).pathname, `/a/${id}/v/1/`);
    const old = await status(await request(`/a/${id}/v/1/`), 200);
    assert.equal(old.headers.get('x-yeet-version'), '1');
    assert.equal(await old.text(), html.toString());
    assert.deepEqual(Buffer.from(await (await status(await request(`/a/${id}/v/1/media/image.png`), 200)).arrayBuffer()), png);
    assert.deepEqual((await json(`/api/artifacts/${id}`)).versions.map(v => v.n), [1, 2]);
  });
  await t.test('ustar download contains exact original bytes and no internal metadata', async () => {
    const response = await status(await request(`/api/artifacts/${id}/versions/1/files.tar`), 200);
    const files = untar(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([...files.keys()].sort(), ['index.html', 'media/clip.mp4', 'media/image.png']);
    for (const [path, bytes] of [['index.html', html], ['media/image.png', png], ['media/clip.mp4', video]]) assert.deepEqual(files.get(path), bytes);
  });
  await t.test('encoded traversal, dotfiles, missing entry and pending cleanup', async () => {
    const target = await create();
    const n = await begin(target);
    for (const path of ['..%2Fescape.html', 'safe%2F..%2Fescape.html', '%2Fabsolute.html', '.env', 'nested%2F.secret', '%2Eyeet.json', '..%5Cescape.html', 'safe%5C..%5Cescape.html', 'bad%00.html', 'C:%5Cescape.html', 'file.txt:secret', 'CON', 'nested/NUL.txt', 'aux.HTML']) {
      await json(`/api/artifacts/${target}/versions/${n}/files/${path}`, { method: 'PUT', body: 'bad', expected: 400 });
    }
    await json(`/api/artifacts/${target}/versions/${n}/commit`, { method: 'POST', expected: 400 });
    for (const path of ['.yeet.json', 'v/1/.yeet.json', 'v/1/%2Eyeet.json', '.env', 'v/1/media/']) await status(await request(`/a/${id}/${path}`), 404);
    const deleted = await request(`/api/artifacts/${target}/versions/${n}`, { method: 'DELETE' });
    assert.ok([200, 204].includes(deleted.status));
    await json(`/api/artifacts/${target}/versions/${n}/commit`, { method: 'POST', expected: 404 });
    await json(`/api/artifacts/${target}/versions`, { method: 'POST', body: { entry: 'script.js' }, expected: 400 });
    await json('/api/artifacts', { method: 'POST', body: { visibility: 'everyone' }, expected: 400 });
    const malformed = await status(await request('/api/artifacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }), 400);
    assert.equal(typeof (await malformed.json()).error, 'string');
  });
  await t.test('browser form login and logout', async () => {
    await status(await request('/', { token: null }), 302);
    const response = await status(await request('/login', { token: null, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: admin, next: '/' }).toString() }), 302);
    assert.equal(new URL(response.headers.get('location'), base).pathname, '/');
    const cookie = response.headers.get('set-cookie').split(';')[0];
    await status(await request('/', { token: null, headers: { Cookie: cookie } }), 200);
    const logout = await request('/logout', { token: null, headers: { Cookie: cookie } });
    assert.ok([200, 302].includes(logout.status));
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });
  await t.test('login next cannot redirect to another origin', async () => {
    for (const next of ['https://evil.example/', '//evil.example/', '/\evil.example/']) {
      const query = new URLSearchParams({ token: admin, next });
      const response = await status(await request(`/login?${query}`, { token: null }), 302);
      const destination = new URL(response.headers.get('location'), base);
      assert.equal(destination.origin, base);
    }
  });
  await t.test('member visibility, browser login and immediate token/session revocation', async () => {
    const alice = await json('/api/members', { method: 'POST', body: { name: 'alice' }, expected: 201 });
    assert.equal(alice.name, 'alice');
    assert.ok(alice.inviteUrl.includes('/join?code='), 'member add returns a one-time invite link');
    assert.equal(alice.token, undefined, 'no raw token in the invite response');
    const minted = await json('/api/members/alice/tokens', { method: 'POST', body: { device: 'test-laptop' }, expected: 201 });
    assert.equal(minted.member, 'alice');
    alice.token = minted.token;
    assert.deepEqual(await json('/api/me', { token: alice.token }), { name: 'alice', role: 'member' });
    assert.ok((await json('/api/members')).members.some(member => member.name === 'alice' && member.revokedAt === null && !('token' in member)));
    const forbidden = await request('/api/members', { token: alice.token });
    assert.ok([403, 404].includes(forbidden.status), 'members cannot use admin endpoints');
    const privateId = await published('private');
    await status(await request(`/a/${privateId}/`, { token: null }), 302);
    await json(`/api/artifacts/${privateId}`, { token: null, expected: 401 });
    const publicId = await published('public');
    for (const path of [`/a/${id}/`, `/api/artifacts/${id}`, `/api/artifacts/${id}/versions/1/files.tar`]) await status(await request(path, { token: alice.token }), 200);
    for (const path of [`/a/${privateId}/`, `/api/artifacts/${privateId}`, `/api/artifacts/${privateId}/versions/1/files.tar`]) await status(await request(path, { token: alice.token }), 404);
    await json(`/api/artifacts/${id}`, { method: 'PATCH', token: alice.token, body: { visibility: 'public' }, expected: 404 });
    assert.deepEqual((await json('/api/artifacts?sourceKey=server-test-source', { token: alice.token })).artifacts, []);
    // Describing a private project keeps the text with its author until they share a page there.
    await json(`/api/artifacts/${privateId}`, { method: 'PATCH', body: { project: 'acquisition' } });
    await json('/api/projects/acquisition', { method: 'PUT', body: { description: 'Buying Company X' } });
    assert.equal((await json('/api/projects/acquisition')).description, 'Buying Company X');
    assert.deepEqual(await json('/api/projects/acquisition', { token: alice.token }), { name: 'acquisition', description: null, updatedBy: null, updatedAt: null });
    await json('/api/artifacts', { method: 'POST', token: alice.token, body: { name: 'Alice guesses', project: 'acquisition' }, expected: 201 });
    assert.doesNotMatch(await (await status(await request('/', { token: alice.token }), 200)).text(), /Buying Company X/);
    await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project: 'acquisition' } });
    assert.equal((await json('/api/projects/acquisition', { token: alice.token })).description, 'Buying Company X', 'shared once the author has a workspace page there');
    assert.match(await (await status(await request('/', { token: alice.token }), 200)).text(), /Buying Company X/);
    await json(`/api/artifacts/${id}`, { method: 'PATCH', body: { project: null } });
    const publicPage = await status(await request(`/a/${publicId}/`, { token: null }), 200);
    assert.equal(publicPage.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(publicPage.headers.get('content-security-policy'), csp);
    await status(await request(`/api/artifacts/${publicId}/versions/1/files.tar`, { token: null }), 200);
    await json(`/api/artifacts/${id}`, { token: null, expected: 401 });
    const next = `/a/${id}/?v=1`;
    const loginRedirect = await status(await request(next, { token: null }), 302);
    const loginUrl = new URL(loginRedirect.headers.get('location'), base);
    assert.equal(loginUrl.pathname, '/login');
    assert.equal(loginUrl.searchParams.get('next'), next);
    const form = await status(await request('/login', { token: null }), 200);
    assert.match(await form.text(), /name=["']password["']/);
    const login = await status(await request(`/login?token=${encodeURIComponent(alice.token)}&next=${encodeURIComponent(next)}`, { token: null }), 302);
    assert.equal(new URL(login.headers.get('location'), base).pathname + new URL(login.headers.get('location'), base).search, next);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^yeet_session=[^;]+;/);
    for (const flag of [/HttpOnly/i, /SameSite=Lax/i, /Path=\//i]) assert.match(setCookie, flag);
    assert.doesNotMatch(setCookie, /;\s*Secure\b/i);
    const lifetime = /Max-Age=(\d+)/i.exec(setCookie);
    if (lifetime) assert.equal(Number(lifetime[1]), 90 * 24 * 60 * 60);
    else assert.ok(Math.abs(Date.parse(/Expires=([^;]+)/i.exec(setCookie)?.[1]) - Date.now() - 90 * 86400000) < 60000);
    const cookie = setCookie.split(';')[0];
    assert.deepEqual(await json('/api/me', { token: null, headers: { Cookie: cookie } }), { name: 'alice', role: 'member' });
    await status(await request(`/a/${id}/`, { token: null, headers: { Cookie: cookie } }), 200);
    const home = await status(await request('/', { token: null, headers: { Cookie: cookie } }), 200);
    const listing = await home.text();
    assert.ok(listing.includes(id));
    assert.ok(!listing.includes(privateId) && !listing.includes(publicId), 'no other member private or public listing');
    const changed = await json(`/api/artifacts/${privateId}`, { method: 'PATCH', body: { visibility: 'workspace' } });
    assert.equal(changed.visibility, 'workspace');
    await status(await request(`/a/${privateId}/`, { token: alice.token }), 200);
    const revoked = await json('/api/members/alice', { method: 'DELETE' });
    assert.ok(Number.isFinite(Date.parse(revoked.revokedAt)));
    await json('/api/me', { token: alice.token, expected: 401 });
    await json('/api/me', { token: null, headers: { Cookie: cookie }, expected: 401 });
    await status(await request(`/a/${id}/`, { token: null, headers: { Cookie: cookie } }), 302);
    await status(await request(`/a/${publicId}/`, { token: null }), 200);
    const logout = await request('/logout', { token: null, headers: { Cookie: cookie } });
    assert.ok([200, 302].includes(logout.status));
    assert.match(logout.headers.get('set-cookie'), /^yeet_session=/);
  });
});
