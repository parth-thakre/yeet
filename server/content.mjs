import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readable } from './auth.mjs';
import { page } from './pages.mjs';
import { fail, redirect } from './store.mjs';

// Published pages are served from a second origin that holds no account authority. A browser
// signed in on the account origin is handed over with a one-time grant, which the content origin
// trades for a cookie scoped to that one page. Both are HMAC-signed and stay valid only while the
// session behind them is live and its member may still read the page.
const grantLife = 60 * 1000;                  // ms
const cookieLife = 12 * 60 * 60 * 1000;       // ms
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{12}$/.test(value);

export async function contentStore(config, auth, artifacts) {
  const origin = config.contentOrigin, host = new URL(origin).host;
  const hosts = new Set([host, /:\d+$/.test(host) ? host : `${host}:${new URL(origin).protocol === 'https:' ? 443 : 80}`]);
  const keyFile = path.join(config.data, 'content-key');
  let key = await fs.readFile(keyFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (key?.length !== 32) {
    key = randomBytes(32);
    const temp = `${keyFile}.${randomBytes(8).toString('hex')}.tmp`;
    try { await fs.writeFile(temp, key, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, keyFile); }
    finally { await fs.rm(temp, { force: true }); }
  }
  // The kind is signed too, so a cookie value can never be replayed as a grant or the reverse.
  const mac = (kind, body) => createHmac('sha256', key).update(`${kind}.${body}`).digest();
  function sign(kind, value) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${mac(kind, body).toString('base64url')}`;
  }
  function verify(kind, token) {
    const [body, signature, extra] = String(token || '').split('.');
    if (!body || !signature || extra !== undefined) return null;
    const given = Buffer.from(signature, 'base64url'), expected = mac(kind, body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claim;
    try { claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    const valid = claim && typeof claim === 'object' && typeof claim.sid === 'string' && typeof claim.member === 'string'
      && validId(claim.artifact) && Number.isFinite(claim.exp);
    return valid ? claim : null;
  }
  // Logout, password changes, revoked terminals, removed members and visibility changes all end access here.
  async function live(claim, meta) {
    if (claim.artifact !== meta.id || claim.exp <= Date.now()) return null;
    const found = await auth.session(claim.sid);
    return found && found.member.name === claim.member && readable(meta, found.member) ? found : null;
  }

  // Host is compared exactly; X-Forwarded-Host is never consulted.
  const serves = req => hosts.has(String(req.headers.host || '').toLowerCase());
  async function grant(req, id, target) {
    const found = await auth.current(req);
    if (!found) fail(401, 'Authentication required');
    return sign('grant', { sid: found.session.id, member: found.member.name, artifact: id, path: target,
      exp: Date.now() + grantLife, nonce: randomBytes(16).toString('base64url') });
  }
  const used = new Map(); // grant nonce -> expiry, in memory: a restart forgets at most a minute of used grants
  async function redeem(req, res, query) {
    for (const [nonce, exp] of used) if (exp <= Date.now()) used.delete(nonce);
    const claim = verify('grant', query.get('t'));
    const target = typeof claim?.path === 'string' ? claim.path : '';
    const scoped = claim && (target.split('?')[0] === `/a/${claim.artifact}` || target.startsWith(`/a/${claim.artifact}/`));
    const fresh = scoped && typeof claim.nonce === 'string' && !used.has(claim.nonce);
    if (fresh) used.set(claim.nonce, claim.exp); // claimed before any await, so a concurrent replay loses
    const meta = fresh ? await artifacts.meta(claim.artifact).catch(error => { if (error.status) return null; throw error; }) : null;
    const found = meta && await live(claim, meta);
    if (!found) {
      const back = `${config.origin}/${claim ? `a/${claim.artifact}/` : ''}`;
      page(res, 'Link expired', `<h1>This link expired</h1><p>This link expired. Reopen it from Yeet.</p><p><a href="${back}">Open it on Yeet</a></p>`, 403);
      return;
    }
    const age = Math.floor(Math.min(cookieLife, Date.parse(found.session.expiresAt) - Date.now()) / 1000);
    const value = sign('cookie', { sid: claim.sid, member: claim.member, artifact: claim.artifact, exp: Date.now() + age * 1000 });
    res.setHeader('Set-Cookie', `yeet_content=${value}; Path=/a/${claim.artifact}/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.insecureCookie ? '' : '; Secure'}`);
    redirect(res, target);
  }
  // Content-host access strategy for artifact(): public pages need nothing; others need a live page cookie.
  // Anything else goes back to the account origin, which signs in or mints a fresh grant.
  const access = (req, res) => async meta => {
    if (meta.visibility === 'public') return false;
    for (const [, token] of (req.headers.cookie || '').matchAll(/(?:^|;\s*)yeet_content=([^;]*)/g)) {
      const claim = verify('cookie', token);
      if (claim && await live(claim, meta)) return false;
    }
    redirect(res, `${config.origin}${req.url}`); return true;
  };
  return { origin, serves, grant, redeem, access };
}
