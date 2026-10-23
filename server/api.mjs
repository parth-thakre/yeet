import { admin, csrfGuard, readable, required } from './auth.mjs';
import { fail, json, jsonBody } from './store.mjs';
import { artifactHeaders } from './serve.mjs';
import { serveTar } from './tar.mjs';

function canRead(meta, member) {
  if (!readable(meta, member)) { required(member); fail(404, 'Not found'); }
}
export async function api(req, res, pathname, query, member, auth, artifacts) {
  const method = req.method;
  if (!pathname.startsWith('/api/')) return false;
  // SameSite=Lax still sends the cookie from sibling origins on the same site, so a browser
  // session may only change state from this origin. Bearer clients are not browsers.
  if (member && req.headers.authorization === undefined && !['GET', 'HEAD'].includes(method)) csrfGuard(req, auth.origin());
  if (pathname === '/api/me' && method === 'GET') {
    required(member); json(res, 200, { name: member.name, role: member.role }); return true;
  }
  // Device-code login: no auth on these two; the poll code is itself a secret.
  if (pathname === '/api/device' && method === 'POST') {
    const client = auth.client(req);
    json(res, 201, auth.beginDevice((await jsonBody(req)).device, client)); return true;
  }
  const poll = /^\/api\/device\/([A-Za-z0-9_-]{20,})$/.exec(pathname);
  if (poll && method === 'GET') { json(res, 200, auth.pollDevice(poll[1])); return true; }
  // One-time browser sign-in link; only a device token may mint one, never a cookie.
  if (pathname === '/api/browser-links' && method === 'POST') {
    json(res, 201, await auth.beginBrowserLink(req, (await jsonBody(req)).next)); return true;
  }
  if (pathname === '/api/tokens' && method === 'GET') {
    required(member); json(res, 200, { tokens: await auth.tokens(member) }); return true;
  }
  const token = /^\/api\/tokens\/([a-f0-9]{12})$/.exec(pathname);
  if (token && method === 'DELETE') { required(member); json(res, 200, await auth.revokeToken(token[1], member)); return true; }
  if (pathname === '/api/members' || pathname.startsWith('/api/members/')) {
    admin(member);
    const named = /^\/api\/members\/([^/]+)(\/invite|\/tokens)?$/.exec(pathname);
    if (pathname === '/api/members' && method === 'GET') json(res, 200, { members: await auth.list() });
    else if (pathname === '/api/members' && method === 'POST') json(res, 201, await auth.create((await jsonBody(req)).name));
    else if (named && named[2] === '/invite' && method === 'POST') json(res, 201, await auth.invite(named[1]));
    else if (named && named[2] === '/tokens' && method === 'POST') json(res, 201, await auth.mintTokenFor(named[1], (await jsonBody(req)).device));
    else if (named && !named[2] && method === 'DELETE') json(res, 200, await auth.revoke(named[1]));
    else fail(404, 'Not found');
    return true;
  }
  if (pathname === '/api/artifacts') {
    required(member);
    if (method === 'POST') json(res, 201, await artifacts.create(member, await jsonBody(req)));
    else if (method === 'GET') {
      const key = query.get('sourceKey');
      // Without a sourceKey this lists all of the caller's own pages, which yeet sort files into projects.
      const values = (await artifacts.list()).filter(value => value.owner === member.name && (key === null || value.sourceKey === key));
      json(res, 200, { artifacts: values.map(({ id, visibility, latest, name, project, updatedAt }) => ({ id, url: artifacts.url(id), visibility, latest, name, project: project ?? null, updatedAt })) });
    } else fail(404, 'Not found');
    return true;
  }
  // The server already decoded pathname, so match the raw URL: a project may contain "/" or "%".
  const named = pathname.startsWith('/api/projects/') && /^\/api\/projects\/([^/]+)$/.exec(req.url.split('?')[0]);
  if (named) {
    required(member);
    let name;
    try { name = decodeURIComponent(named[1]); } catch { fail(400, 'Invalid project name'); }
    if (method === 'GET') json(res, 200, await artifacts.project(name, member));
    else if (method === 'PUT') json(res, 200, await artifacts.describe(name, member, (await jsonBody(req)).description ?? null));
    else fail(404, 'Not found');
    return true;
  }
  const match = /^\/api\/artifacts\/([A-Za-z0-9_-]{12})(.*)$/.exec(pathname);
  if (!match) fail(404, 'Not found');
  const [, id, suffix] = match;
  if (!suffix && method === 'GET') {
    const value = await artifacts.meta(id); canRead(value, member);
    const result = await artifacts.detail(value);
    // Only the owner can upload, so only they need to see an upload that is still pending.
    if (member?.name === value.owner) result.pending = await artifacts.pending(id);
    json(res, 200, result); return true;
  }
  const tar = /^\/versions\/([1-9]\d*)\/files\.tar$/.exec(suffix);
  if (tar && ['GET', 'HEAD'].includes(method)) {
    const value = await artifacts.meta(id); canRead(value, member);
    const n = Number(tar[1]);
    const info = await artifacts.version(id, n);
    artifactHeaders(res, value, n);
    await serveTar(req, res, info.root, info.createdAt, id, n); return true;
  }
  required(member);
  if (!suffix && method === 'PATCH') {
    json(res, 200, await artifacts.patch(id, member, await jsonBody(req))); return true;
  }
  if (suffix === '/versions' && method === 'POST') {
    json(res, 201, await artifacts.begin(id, member, (await jsonBody(req)).entry)); return true;
  }
  const version = /^\/versions\/([1-9]\d*)(.*)$/.exec(suffix);
  if (!version) fail(404, 'Not found');
  const n = Number(version[1]), tail = version[2];
  if (tail.startsWith('/files/') && method === 'PUT') json(res, 201, await artifacts.upload(id, n, member, tail.slice(7), req));
  else if (tail === '/commit' && method === 'POST') json(res, 200, await artifacts.commit(id, n, member));
  else if (!tail && method === 'DELETE') { await artifacts.abandon(id, n, member); res.writeHead(204); res.end(); }
  else fail(404, 'Not found');
  return true;
}
