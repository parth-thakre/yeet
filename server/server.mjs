import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { authStore, formGuard, readable } from './auth.mjs';
import { artifactStore } from './artifacts.mjs';
import { api } from './api.mjs';
import { browser, openPage } from './pages.mjs';
import { contentStore } from './content.mjs';
import { artifactHeaders, serveFile } from './serve.mjs';
import { fail, json, redirect, safeFile, validPath } from './store.mjs';

// Serves /a/<id>/... on whichever origin finally answers. allow(meta, relative) decides access: true when it
// has already answered (a redirect), else optionally { cache } to override Cache-Control. The normalization
// redirects run where the page is served. Only the account origin in split mode also takes POST.
async function artifact(req, res, pathname, query, artifacts, allow, methods = ['GET', 'HEAD']) {
  if (!pathname.startsWith('/a/') || !methods.includes(req.method)) return false;
  const match = /^\/a\/([A-Za-z0-9_-]{12})(?:\/(.*))?$/.exec(pathname);
  if (!match) fail(404, 'Not found');
  const [, id, relative] = match;
  if (relative && !validPath(relative.endsWith('/') ? relative.slice(0, -1) : relative)) fail(404, 'Not found');
  const value = await artifacts.meta(id);
  const access = await allow(value, relative);
  if (access === true) return true;
  let n = value.latest, file = relative || '';
  const pinned = /^v\/([1-9]\d*)(?:\/(.*))?$/.exec(file);
  if (pinned) { n = Number(pinned[1]); file = pinned[2] || ''; }
  if (!relative && query.has('v')) {
    if (!/^[1-9]\d*$/.test(query.get('v'))) fail(400, 'Invalid version');
    n = Number(query.get('v'));
  }
  artifactHeaders(res, value, n);
  if (access?.cache) res.setHeader('Cache-Control', access.cache);
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
// Account origin: today's readability rules. With a content origin, verified bearer clients are still
// served here, but browsers are sent on: public pages directly, others through a one-time grant.
const accountAccess = (req, res, member, content, auth) => async (value, relative) => {
  const post = req.method === 'POST';
  if (post) formGuard(req, auth.origin()); // the "Open this page" form; it has no fields to read
  if (!readable(value, member)) {
    if (!member) {
      if (req.headers.authorization !== undefined || /application\/json/i.test(req.headers.accept || '')) fail(401, 'Authentication required');
      redirect(res, `/login?next=${encodeURIComponent(req.url)}`); return true;
    }
    fail(404, 'Not found');
  }
  if (!content) return false;
  // identify() reads only Authorization when it is present, so a member here came from a Bearer token.
  // A shared cache must never replay those bytes to a browser.
  if (member && req.headers.authorization !== undefined) {
    if (post) fail(404, 'Not found');
    return { cache: 'private, no-store' };
  }
  // Canonical target: the page cookie is scoped to /a/<id>/, so hand over the slash form, re-encoded.
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `/a/${value.id}/${(relative || '').split('/').map(encodeURIComponent).join('/')}${search}`;
  if (value.visibility === 'public') { redirect(res, content.origin + target, post ? 303 : 302); return true; }
  // Mint grants only for a navigation the user started: a link click, typed URL or form submit. A
  // subresource, prefetch or script-started navigation from another page of the same site would
  // otherwise plant this page's cookie where that page can read it. Without that evidence (including
  // browsers that send no Fetch Metadata), ask for a click on a same-origin form instead.
  const { 'sec-fetch-mode': mode, 'sec-fetch-dest': dest } = req.headers;
  if (!post) {
    if ((mode !== undefined && mode !== 'navigate') || (dest !== undefined && dest !== 'document')) fail(404, 'Not found');
    const activated = mode === 'navigate' && dest === 'document' && req.headers['sec-fetch-user'] === '?1'
      && req.headers['sec-purpose'] === undefined && req.headers.purpose === undefined;
    if (!activated) { openPage(res, value.name || value.id); return true; }
  }
  redirect(res, `${content.origin}/.yeet/grant?t=${await content.grant(req, value.id, target)}`, post ? 303 : 302);
  return true;
};
function originFrom(value, name) {
  let url;
  try { url = new URL(value); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== value) throw new Error(`${name} must be an HTTP(S) origin without a path or credentials`);
  return url;
}
export async function createServer(env = process.env) {
  const port = Number(env.YEET_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid YEET_PORT');
  // Loopback unless told otherwise: the container sets 0.0.0.0 and Compose publishes it on loopback.
  const host = env.YEET_HOST || '127.0.0.1';
  const config = { data: path.resolve(env.YEET_DATA || './data'), origin: (env.YEET_ORIGIN || '').replace(/\/+$/, ''),
    contentOrigin: (env.YEET_CONTENT_ORIGIN || '').replace(/\/+$/, ''),
    adminToken: env.YEET_ADMIN_TOKEN, insecureCookie: env.YEET_INSECURE_COOKIE === '1', trustProxy: env.YEET_TRUST_PROXY === '1' };
  const origin = config.origin ? originFrom(config.origin, 'YEET_ORIGIN') : null;
  if (config.contentOrigin) {
    if (!origin) throw new Error('YEET_CONTENT_ORIGIN needs YEET_ORIGIN set too');
    // Requests are routed by Host header, so the two origins need different hostnames, not just ports.
    const contentUrl = originFrom(config.contentOrigin, 'YEET_CONTENT_ORIGIN');
    if (contentUrl.hostname === origin.hostname) throw new Error('YEET_CONTENT_ORIGIN must use a different hostname from YEET_ORIGIN');
    // Account pages name the content origin in form-action, and CSP host-sources allow only
    // letters, digits, dots and hyphens: no IPv6 literals or underscores.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(contentUrl.hostname)) throw new Error('YEET_CONTENT_ORIGIN must use a hostname of letters, digits, dots and hyphens, or an IPv4 address');
    if (origin.protocol === 'https:' && contentUrl.protocol !== 'https:') throw new Error('YEET_CONTENT_ORIGIN must use https when YEET_ORIGIN does');
  }
  const auth = await authStore(config);
  const artifacts = await artifactStore(config);
  const content = config.contentOrigin ? await contentStore(config, auth, artifacts) : null;
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
    // Account pages' form-action: Chromium applies it to every redirect after a form post, and sign-in
    // and the "Open this page" form both end on the content origin.
    res.formTargets = content ? `'self' ${content.origin}` : "'self'";
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
      // The content origin never reads the session cookie or Authorization and has no account routes.
      if (content?.serves(req)) {
        if (pathname === '/.yeet/grant' && ['GET', 'HEAD'].includes(req.method)) { await content.redeem(req, res, query); return; }
        if (await artifact(req, res, pathname, query, artifacts, content.access(req, res))) return;
        fail(404, 'Not found');
      }
      const member = await auth.identify(req);
      if (await api(req, res, pathname, query, member, auth, artifacts)) return;
      if (await browser(req, res, pathname, query, member, auth, artifacts)) return;
      if (await artifact(req, res, pathname, query, artifacts, accountAccess(req, res, member, content, auth), content ? ['GET', 'HEAD', 'POST'] : undefined)) return;
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
    if (!content) console.warn('Warning: published pages share the account origin, so their scripts can act as anyone who opens them. Set YEET_CONTENT_ORIGIN to serve them from a separate hostname.');
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
