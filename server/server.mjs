import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { authStore, readable } from './auth.mjs';
import { artifactStore } from './artifacts.mjs';
import { api } from './api.mjs';
import { browser } from './pages.mjs';
import { artifactHeaders, serveFile } from './serve.mjs';
import { fail, json, redirect, safeFile, validPath } from './store.mjs';

async function artifact(req, res, pathname, query, member, artifacts) {
  if (!pathname.startsWith('/a/') || !['GET', 'HEAD'].includes(req.method)) return false;
  const match = /^\/a\/([A-Za-z0-9_-]{12})(?:\/(.*))?$/.exec(pathname);
  if (!match) fail(404, 'Not found');
  const [, id, relative] = match;
  if (relative && !validPath(relative.endsWith('/') ? relative.slice(0, -1) : relative)) fail(404, 'Not found');
  const value = await artifacts.meta(id);
  if (!readable(value, member)) {
    if (!member) {
      if (req.headers.authorization !== undefined || /application\/json/i.test(req.headers.accept || '')) fail(401, 'Authentication required');
      redirect(res, `/login?next=${encodeURIComponent(req.url)}`); return true;
    }
    fail(404, 'Not found');
  }
  let n = value.latest, file = relative || '';
  const pinned = /^v\/([1-9]\d*)(?:\/(.*))?$/.exec(file);
  if (pinned) { n = Number(pinned[1]); file = pinned[2] || ''; }
  if (!relative && query.has('v')) {
    if (!/^[1-9]\d*$/.test(query.get('v'))) fail(400, 'Invalid version');
    n = Number(query.get('v'));
  }
  artifactHeaders(res, value, n);
  if (relative === undefined) {
    const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    redirect(res, `/a/${id}/${search}`); return true;
  }
  const info = await artifacts.version(id, n);
  if (!relative && query.has('v')) { redirect(res, `/a/${id}/v/${n}/`); return true; }
  if (pinned && pinned[2] === undefined) { redirect(res, `/a/${id}/v/${n}/`); return true; }
  file = file ? (file.endsWith('/') ? `${file}index.html` : file) : info.entry;
  await serveFile(req, res, await safeFile(info.root, file), true);
  return true;
}
export async function createServer(env = process.env) {
  const port = Number(env.YEET_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid YEET_PORT');
  // Loopback unless told otherwise: the container sets 0.0.0.0 and Compose publishes it on loopback.
  const host = env.YEET_HOST || '127.0.0.1';
  const config = { data: path.resolve(env.YEET_DATA || './data'), origin: (env.YEET_ORIGIN || '').replace(/\/+$/, ''),
    adminToken: env.YEET_ADMIN_TOKEN, insecureCookie: env.YEET_INSECURE_COOKIE === '1', trustProxy: env.YEET_TRUST_PROXY === '1' };
  if (config.origin) {
    const origin = new URL(config.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== config.origin) throw new Error('YEET_ORIGIN must be an HTTP(S) origin without a path or credentials');
  }
  const auth = await authStore(config);
  const artifacts = await artifactStore(config);
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const rawPath = req.url.split('?')[0];
    const logPath = rawPath.startsWith('/api/device/') ? '/api/device/[redacted]' : rawPath;
    let logged = false;
    function log() {
      if (logged) return;
      logged = true;
      console.log(`${req.method} ${logPath} ${res.writableFinished ? res.statusCode : 499} ${(performance.now() - started).toFixed(1)}ms`);
    }
    res.once('finish', log); res.once('close', log);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      let pathname;
      try { pathname = decodeURIComponent(rawPath); } catch { fail(400, 'Invalid URL encoding'); }
      if (!pathname.startsWith('/') || pathname.startsWith('//')) fail(400, 'Invalid request path');
      const query = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
      if (pathname === '/healthz' && ['GET', 'HEAD'].includes(req.method)) { json(res, 200, { ok: true }); return; }
      if (pathname === '/css/yeet-v1.css' && ['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        await serveFile(req, res, fileURLToPath(new URL('./public/yeet-v1.css', import.meta.url))); return;
      }
      const member = await auth.identify(req);
      if (await api(req, res, pathname, query, member, auth, artifacts)) return;
      if (await browser(req, res, pathname, query, member, auth, artifacts)) return;
      if (await artifact(req, res, pathname, query, member, artifacts)) return;
      fail(404, 'Not found');
    } catch (error) {
      req.resume();
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const status = error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : ['EISDIR', 'EEXIST', 'ENAMETOOLONG', 'EINVAL'].includes(error.code) ? 400 : 500);
      if (status === 500) console.error(`Unexpected error on ${req.method} ${logPath}: ${error.stack || error}`);
      res.removeHeader('Content-Length');
      res.setHeader('Cache-Control', 'no-store');
      json(res, status, { error: error.status ? error.message : status === 404 ? 'Not found' : status === 400 ? 'Invalid file path' : 'Internal server error' });
    }
  });
  server.on('listening', () => {
    const bound = server.address();
    const address = `http://${bound.family === 'IPv6' ? `[${bound.address}]` : bound.address}:${bound.port}`;
    config.origin ||= `http://127.0.0.1:${bound.port}`;
    console.log(`Yeet listening on ${address}`);
    if (config.setupCode) console.log(`Set up your admin account (keep this link private): ${config.origin}/setup?code=${config.setupCode}`);
  });
  return { server, port, host };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { server, port, host } = await createServer();
    server.on('error', error => { console.error(`Server error: ${error.code || error.name}`); process.exitCode = 1; });
    server.listen(port, host);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      const timer = setTimeout(() => server.closeAllConnections(), 10000).unref();
      server.close(() => clearTimeout(timer));
    };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
