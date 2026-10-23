import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fail, locks, now, readJSON, writeJSON } from './store.mjs';
import { loginThrottle, passwordHash, passwordMatches } from './passwords.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const sessionLife = 90 * 24 * 60 * 60;           // seconds
const inviteLife = 7 * 24 * 60 * 60 * 1000;      // ms
const deviceLife = 10 * 60 * 1000;               // ms
const deliveryGrace = 60 * 1000;                 // ms an approved token stays fetchable after first delivery
const browserLinkLife = 2 * 60 * 1000;           // ms
const maxBrowserLinksPerToken = 20;
const maxPending = 1000;
const maxPendingPerClient = 10;
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function userCode() {
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += codeAlphabet[bytes[i] % codeAlphabet.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
export const normalizeCode = value => {
  const raw = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : null;
};
const validName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
const validDevice = name => typeof name === 'string' && /^[\x20-\x7e]{1,64}$/.test(name);

export async function authStore(config) {
  await fs.mkdir(config.data, { recursive: true });
  const membersFile = path.join(config.data, 'members.json');
  const sessionsFile = path.join(config.data, 'sessions.json');
  const lock = locks();
  const pending = new Map(); // userCode -> device login request, in memory only
  const browserLinks = new Map(); // codeHash -> one-time browser sign-in from a device token, in memory only
  const throttle = loginThrottle();
  const setupFile = path.join(config.data, 'setup.json');

  async function load() {
    const stored = await readJSON(membersFile, null);
    if (!stored) return null;
    let changed = false;
    stored.tokens ||= [];
    stored.invites ||= [];
    for (const member of stored.members) {
      if (member.tokenHash) { // migrate v1 per-member tokens to per-device tokens
        stored.tokens.push({ id: randomBytes(6).toString('hex'), member: member.name, device: 'legacy', tokenHash: member.tokenHash,
          createdAt: member.createdAt, revokedAt: member.revokedAt });
        delete member.tokenHash;
        changed = true;
      }
    }
    if (changed) await writeJSON(membersFile, stored);
    return stored;
  }
  if (!(await load())) {
    const timestamp = now();
    const setup = config.adminToken ? null : (await readJSON(setupFile, null) || { code: secret() });
    if (setup) await writeJSON(setupFile, setup);
    await writeJSON(membersFile, {
      members: config.adminToken ? [{ name: 'admin', role: 'admin', createdAt: timestamp, revokedAt: null }] : [],
      tokens: config.adminToken ? [{ id: randomBytes(6).toString('hex'), member: 'admin', device: 'bootstrap', tokenHash: hash(config.adminToken), createdAt: timestamp, revokedAt: null }] : [],
      invites: [],
      ...(setup ? { setupHash: hash(setup.code) } : {}),
    });
  }
  if ((await load()).setupHash) config.setupCode = (await readJSON(setupFile)).code;
  if (!(await readJSON(sessionsFile, null))) await writeJSON(sessionsFile, { sessions: [] });

  const activeMember = (stored, name) => stored.members.find(m => m.name === name && !m.revokedAt) || null;
  async function tokenEntry(token) {
    if (!token) return null;
    const stored = await load();
    const digest = hash(token);
    const entry = stored.tokens.find(t => !t.revokedAt && t.tokenHash === digest);
    const member = entry ? activeMember(stored, entry.member) : null;
    return member ? { entry, member } : null;
  }
  async function tokenMember(token) { return (await tokenEntry(token))?.member || null; }
  const cookieValue = req => /(?:^|;\s*)yeet_session=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
  async function identify(req) {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization);
      return match ? tokenMember(match[1]) : null;
    }
    const value = cookieValue(req);
    if (!value) return null;
    const session = (await readJSON(sessionsFile)).sessions.find(s => s.cookieHash === hash(value) && Date.parse(s.expiresAt) > Date.now());
    if (!session) return null;
    const stored = await load();
    const member = activeMember(stored, session.member);
    // A session opened through a terminal lives only as long as that terminal's token.
    if (session.tokenId && !stored.tokens.some(t => t.id === session.tokenId && !t.revokedAt)) return null;
    return member && (session.authVersion || 0) === (member.authVersion || 0) ? member : null;
  }
  function cookie(value, age = sessionLife) {
    return `yeet_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.insecureCookie ? '' : '; Secure'}`;
  }
  async function pruneSessions(keep) {
    return lock('sessions', async () => {
      const stored = await readJSON(sessionsFile);
      stored.sessions = stored.sessions.filter(s => Date.parse(s.expiresAt) > Date.now() && keep(s));
      await writeJSON(sessionsFile, stored);
    });
  }
  async function sessionFor(member, tokenId = null) {
    return lock('sessions', async () => {
      const value = secret();
      const stored = await readJSON(sessionsFile);
      stored.sessions = stored.sessions.filter(s => Date.parse(s.expiresAt) > Date.now());
      stored.sessions.push({ id: randomBytes(12).toString('hex'), cookieHash: hash(value), member: member.name, tokenId, createdAt: now(),
        authVersion: member.authVersion || 0,
        expiresAt: new Date(Date.now() + sessionLife * 1000).toISOString() });
      await writeJSON(sessionsFile, stored);
      return cookie(value);
    });
  }
  async function login(token) {
    const found = await tokenEntry(token);
    if (!found) fail(401, 'Invalid token');
    return sessionFor(found.member, found.entry.id);
  }
  async function logout(req) {
    const value = cookieValue(req);
    if (value) await pruneSessions(s => s.cookieHash !== hash(value));
    return cookie('', 0);
  }

  function client(req) {
    return String(config.trustProxy ? req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress : req.socket.remoteAddress).split(',')[0].trim();
  }
  const attempt = req => throttle(client(req));
  async function passwordLogin(name, password) {
    const member = activeMember(await load(), name);
    if (!(await passwordMatches(password, member?.passwordHash))) fail(401, 'Username or password is incorrect.');
    return lock('auth', async () => {
      const current = activeMember(await load(), name);
      if (!current || current.passwordHash !== member.passwordHash) fail(401, 'Username or password is incorrect.');
      return sessionFor(current);
    });
  }
  async function setup(code, name, password) {
    return lock('auth', async () => {
      const stored = await load();
      if (!stored.setupHash || stored.setupHash !== hash(String(code || ''))) fail(400, 'This setup link is invalid or has already been used.');
      if (!validName(name)) fail(400, 'Use a username of 1-64 letters, digits, underscores or hyphens.');
      const member = { name, role: 'admin', passwordHash: await passwordHash(password), createdAt: now(), revokedAt: null };
      stored.members.push(member);
      delete stored.setupHash;
      await writeJSON(membersFile, stored);
      // members.json is authoritative, including if removing this file fails after a crash.
      await fs.rm(setupFile, { force: true }).catch(() => {});
      delete config.setupCode;
      return sessionFor(member);
    });
  }
  async function setupAvailable(code) {
    const stored = await load();
    return Boolean(stored.setupHash && stored.setupHash === hash(String(code || '')));
  }
  function invalidate(stored, member) {
    member.authVersion = (member.authVersion || 0) + 1;
    for (const token of stored.tokens) if (token.member === member.name) token.revokedAt ||= now();
    stored.invites = stored.invites.filter(i => i.member !== member.name);
  }
  async function changePassword(member, currentPassword, password) {
    return lock('auth', async () => {
      const stored = await load();
      const current = activeMember(stored, member.name);
      if (!current || (current.authVersion || 0) !== (member.authVersion || 0)) fail(401, 'Sign in again.');
      if (current.passwordHash && !(await passwordMatches(currentPassword, current.passwordHash))) fail(401, 'Current password is incorrect.');
      current.passwordHash = await passwordHash(password);
      // Adding a password to a legacy account preserves its existing connections.
      if (member.passwordHash) invalidate(stored, current);
      await writeJSON(membersFile, stored);
      return sessionFor(current);
    });
  }

  // Members and one-time invite links
  function makeInvite(stored, name) {
    const code = secret();
    const expiresAt = new Date(Date.now() + inviteLife).toISOString();
    stored.invites = stored.invites.filter(i => i.member !== name && Date.parse(i.expiresAt) > Date.now() && !i.usedAt);
    stored.invites.push({ codeHash: hash(code), member: name, createdAt: now(), expiresAt, usedAt: null });
    return { name, inviteUrl: `${config.origin}/join?code=${code}`, expiresAt };
  }
  async function create(name) {
    if (!validName(name)) fail(400, 'Use a member name of 1-64 letters, digits, underscores or hyphens');
    return lock('auth', async () => {
      const stored = await load();
      if (stored.members.some(m => m.name === name)) fail(409, 'Member name already exists');
      stored.members.push({ name, role: 'member', createdAt: now(), revokedAt: null });
      const result = makeInvite(stored, name);
      await writeJSON(membersFile, stored);
      return result;
    });
  }
  async function invite(name) {
    return lock('auth', async () => {
      const stored = await load();
      if (!activeMember(stored, name)) fail(404, 'Not found');
      const result = makeInvite(stored, name);
      await writeJSON(membersFile, stored);
      return result;
    });
  }
  async function inviteInfo(code) {
    const stored = await load();
    const entry = stored.invites.find(i => i.codeHash === hash(String(code || '')));
    const member = entry ? activeMember(stored, entry.member) : null;
    if (!member || entry.usedAt || Date.parse(entry.expiresAt) <= Date.now()) fail(400, 'This invite link is invalid, used, or expired');
    return { name: member.name, reset: Boolean(member.passwordHash) };
  }
  async function join(code, password) {
    return lock('auth', async () => {
      const stored = await load();
      const digest = hash(String(code || ''));
      const entry = stored.invites.find(i => i.codeHash === digest);
      if (!entry || entry.usedAt || Date.parse(entry.expiresAt) <= Date.now()) fail(400, 'This invite link is invalid, used, or expired');
      const member = activeMember(stored, entry.member);
      if (!member) fail(400, 'This invite link is invalid, used, or expired');
      member.passwordHash = await passwordHash(password);
      invalidate(stored, member);
      entry.usedAt = now();
      await writeJSON(membersFile, stored);
      return { member, cookie: await sessionFor(member) };
    });
  }
  async function revoke(name) {
    return lock('auth', async () => {
      const stored = await load();
      const member = stored.members.find(m => m.name === name);
      if (!member) fail(404, 'Not found');
      if (member.role === 'admin') fail(400, 'Cannot revoke the admin');
      member.revokedAt ||= now();
      for (const t of stored.tokens) if (t.member === name) t.revokedAt ||= member.revokedAt;
      stored.invites = stored.invites.filter(i => i.member !== name);
      await writeJSON(membersFile, stored);
      await pruneSessions(s => s.member !== name);
      return { name, revokedAt: member.revokedAt };
    });
  }
  async function list() {
    return (await load()).members.map(({ name, role, createdAt, revokedAt }) => ({ name, role, createdAt, revokedAt }));
  }

  // Per-device tokens
  async function tokens(member) {
    const stored = await load();
    return stored.tokens.filter(t => (member.role === 'admin' || t.member === member.name) && !t.revokedAt)
      .map(({ id, member: owner, device, createdAt }) => ({ id, member: owner, device, createdAt }));
  }
  async function revokeToken(id, member) {
    return lock('auth', async () => {
      const stored = await load();
      const entry = stored.tokens.find(t => t.id === id && !t.revokedAt);
      if (!entry || (member.role !== 'admin' && entry.member !== member.name)) fail(404, 'Not found');
      entry.revokedAt = now();
      await writeJSON(membersFile, stored);
      await pruneSessions(s => s.tokenId !== id); // cookies obtained with this token die with it
      return { id, revokedAt: entry.revokedAt };
    });
  }
  async function mintToken(member, device) {
    return lock('auth', async () => {
      const stored = await load();
      const current = activeMember(stored, member.name);
      if (!current || (current.authVersion || 0) !== (member.authVersion || 0)) fail(401, 'Authentication required');
      const token = secret();
      const entry = { id: randomBytes(6).toString('hex'), member: member.name, device, tokenHash: hash(token), createdAt: now(), revokedAt: null };
      stored.tokens.push(entry);
      await writeJSON(membersFile, stored);
      return { id: entry.id, token };
    });
  }
  async function mintTokenFor(name, device) {
    if (!validDevice(device)) fail(400, 'Device name must be 1-64 printable characters');
    const member = activeMember(await load(), name);
    if (!member) fail(404, 'Not found');
    const minted = await mintToken(member, device);
    return { ...minted, member: name, device };
  }

  // Device-code login: the CLI asks for a code, a logged-in browser approves it, the CLI polls for the token.
  function prune() {
    for (const [code, request] of pending) if (request.expiresAt <= Date.now()) pending.delete(code);
  }
  function beginDevice(device, client = 'unknown') {
    if (!validDevice(device)) fail(400, 'Device name must be 1-64 printable characters');
    prune();
    if (pending.size >= maxPending) fail(429, 'Too many pending logins; try again in a few minutes');
    let mine = 0;
    for (const request of pending.values()) if (request.client === client && request.status === 'pending') mine++;
    if (mine >= maxPendingPerClient) fail(429, 'Too many pending logins from this client; approve or wait for them to expire');
    let code;
    do code = userCode(); while (pending.has(code));
    const pollCode = secret();
    pending.set(code, { userCode: code, pollCode, device, client, createdAt: Date.now(), expiresAt: Date.now() + deviceLife, status: 'pending', token: null, member: null, deliveredAt: null });
    return { code: pollCode, userCode: code, verifyUrl: `${config.origin}/devices/add?code=${code}`, expiresIn: deviceLife / 1000, interval: 3 };
  }
  function deviceRequest(rawCode) {
    prune();
    const request = pending.get(normalizeCode(rawCode));
    if (!request || request.status !== 'pending') fail(404, 'Unknown or expired code');
    return { userCode: request.userCode, device: request.device, createdAt: new Date(request.createdAt).toISOString() };
  }
  async function approveDevice(rawCode, member) {
    prune();
    const request = pending.get(normalizeCode(rawCode));
    if (!request || request.status !== 'pending') fail(404, 'Unknown or expired code');
    request.status = 'approving'; // claim it synchronously so a concurrent approve or deny cannot race the mint
    let minted;
    try { minted = await mintToken(member, request.device); }
    catch (error) { request.status = 'pending'; throw error; }
    Object.assign(request, { status: 'approved', token: minted.token, member: member.name, expiresAt: Date.now() + deviceLife });
    return { userCode: request.userCode, device: request.device, member: member.name };
  }
  function denyDevice(rawCode) {
    prune();
    const request = pending.get(normalizeCode(rawCode));
    if (!request || request.status !== 'pending') fail(404, 'Unknown or expired code');
    request.status = 'denied';
    return { userCode: request.userCode };
  }
  function pollDevice(pollCode) {
    prune();
    const request = [...pending.values()].find(r => r.pollCode === pollCode);
    if (!request) fail(404, 'Unknown or expired code');
    if (request.status === 'approved') {
      if (!request.deliveredAt) { request.deliveredAt = Date.now(); request.expiresAt = Date.now() + deliveryGrace; } // a lost response can be retried briefly
      return { status: 'approved', token: request.token, member: request.member, device: request.device };
    }
    if (request.status === 'denied') { pending.delete(request.userCode); return { status: 'denied' }; }
    return { status: 'pending' };
  }

  // Browser sign-in links: a connected terminal signs a browser on the same machine in, so each
  // machine needs one `yeet login` rather than a password in every browser. The session is tied to
  // the device token, so revoking that terminal signs these browsers out too.
  function pruneBrowserLinks() {
    for (const [digest, link] of browserLinks) if (link.expiresAt <= Date.now()) browserLinks.delete(digest);
  }
  async function beginBrowserLink(req, next) {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    const found = match ? await tokenEntry(match[1]) : null;
    if (!found) fail(401, 'A connected terminal token is required; run yeet login');
    pruneBrowserLinks();
    if (browserLinks.size >= maxPending) fail(429, 'Too many pending sign-in links; try again in a few minutes');
    if ([...browserLinks.values()].filter(link => link.tokenId === found.entry.id).length >= maxBrowserLinksPerToken) {
      fail(429, 'Too many pending sign-in links from this terminal; wait two minutes');
    }
    const code = secret();
    browserLinks.set(hash(code), { tokenId: found.entry.id, member: found.member.name, device: found.entry.device,
      next: typeof next === 'string' ? next : '/', expiresAt: Date.now() + browserLinkLife });
    return { code, member: found.member.name, device: found.entry.device, expiresIn: browserLinkLife / 1000 };
  }
  async function browserLink(code) {
    pruneBrowserLinks();
    const link = browserLinks.get(hash(String(code || '')));
    const stored = link ? await load() : null;
    const entry = stored?.tokens.find(t => t.id === link.tokenId && !t.revokedAt);
    const member = entry ? activeMember(stored, entry.member) : null;
    if (!member) fail(400, 'This sign-in link is invalid, used, or expired');
    return { link, member };
  }
  async function browserLinkInfo(code) {
    const { link, member } = await browserLink(code);
    return { member: member.name, device: link.device };
  }
  async function useBrowserLink(code, req) {
    // Under the auth lock so a terminal revoked mid-redemption cannot leave a session behind.
    return lock('auth', async () => {
      const digest = hash(String(code || ''));
      const { link, member } = await browserLink(code);
      if (!browserLinks.delete(digest)) fail(400, 'This sign-in link is invalid, used, or expired'); // a concurrent use won
      const previous = cookieValue(req);
      if (previous) await pruneSessions(s => s.cookieHash !== hash(previous));
      return { cookie: await sessionFor(member, link.tokenId), next: link.next };
    });
  }

  return { identify, login, logout, cookie, sessionFor, create, invite, join, inviteInfo, revoke, list, tokens, revokeToken, mintTokenFor, beginDevice, deviceRequest, approveDevice, denyDevice, pollDevice,
    beginBrowserLink, browserLinkInfo, useBrowserLink,
    attempt, client, passwordLogin, setup, setupAvailable, changePassword, origin: () => config.origin };
}
export function required(member) { if (!member) fail(401, 'Authentication required'); return member; }
export function admin(member) { required(member); if (member.role !== 'admin') fail(403, 'Admin required'); }
export function readable(meta, member) {
  return meta.visibility === 'public' || Boolean(member && (meta.visibility === 'workspace' || meta.owner === member.name));
}
export function owner(meta, member) { required(member); if (meta.owner !== member.name) fail(404, 'Not found'); }
// Browsers label every request with Sec-Fetch-Site. State-changing requests must come from this
// origin itself (or a direct navigation); same-site sibling origins and other sites are refused.
// Form posts and cookie-authenticated API writes both go through csrfGuard.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined) return site === 'same-origin' || site === 'none';
  return true; // non-browser clients (tests, curl) do not send it; cookies are not auto-attached there either
}
export function csrfGuard(req, origin) {
  if (!sameOrigin(req) || (req.headers.origin !== undefined && req.headers.origin !== origin)) fail(403, 'Cross-site request refused');
}
