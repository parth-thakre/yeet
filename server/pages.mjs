import { body, fail, redirect } from './store.mjs';
import { csrfGuard, normalizeCode } from './auth.mjs';
import { accounts } from './accounts.mjs';

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const style = `:root{color-scheme:light dark;--paper:#ffffff;--ink:#1b1f23;--muted:#56616b;--link:#164e9d;--rule:#d7dce0;font:17px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){:root{--paper:#0f1419;--ink:#e6e9ec;--muted:#bcc5ce;--link:#9dc5ff;--rule:#3b4650}}*{box-sizing:border-box}body{margin:0;padding:1.25rem;max-width:70ch;margin-inline:auto;background:var(--paper);color:var(--ink)}h1{font-size:1.9rem;line-height:1.2}h2{font-size:1.3rem;line-height:1.3;margin:2rem 0 0}h2+p{margin:.25rem 0 0}h2 .detail{font-weight:normal}a{color:var(--link)}header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap}nav{display:flex;flex-wrap:wrap;gap:.25rem 1rem;margin-block:1rem}nav a{display:inline-block;white-space:nowrap}ul{list-style:none;padding:0}li{padding:1rem 0;border-bottom:1px solid var(--rule)}li a{font-size:1.15rem;overflow-wrap:anywhere}p{margin:.4rem 0 1rem}.detail{font-size:.9rem;color:var(--muted);overflow-wrap:anywhere}label{display:block}input,button{font:inherit;padding:.65rem;margin:.5rem 0 1rem;max-width:100%;color:var(--ink);background:var(--paper);border:1px solid var(--muted);border-radius:.3rem}input{width:100%}button{cursor:pointer;margin-right:.5rem}button.small{padding:.35rem .6rem;margin:.25rem 0 0;font-size:.9rem}.code{font:1.6rem/1.2 ui-monospace,monospace;letter-spacing:.08em}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid var(--link);outline-offset:3px}`;
function page(res, title, content, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} | Yeet</title><style>${style}pre{overflow-x:auto;padding:1rem;background:var(--rule);border-radius:.3rem}p a{overflow-wrap:anywhere}details{margin-block:1.5rem}summary{cursor:pointer}.error{border-left:3px solid currentColor;padding:.75rem}form{max-width:28rem}input[type=hidden]{display:none}</style></head><body><main>${content}</main></body></html>`;
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  // no-referrer makes Chromium send Origin: null on HTML form posts. Send only
  // the origin, never a setup/invite code or private artifact path.
  res.setHeader('Referrer-Policy', 'strict-origin');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}
export function nextPath(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || [...value].some(c => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 92)) return '/';
  const url = new URL(value, 'http://yeet.local');
  if (url.origin !== 'http://yeet.local' || url.pathname.startsWith('//')) return '/'; // normalization can turn /a/..//x into //x
  return url.pathname + url.search + url.hash;
}
const nav = member => `<header><a href="/">Yeet</a>${member ? '<a href="/logout">Log out</a>' : ''}</header>${member ? `<nav aria-label="Main"><a href="/">Workspace</a><a href="/connect">Connect terminal</a><a href="/devices">Terminals</a><a href="/account">Account</a>${member.role === 'admin' ? '<a href="/people">People</a>' : ''}</nav><p class="detail">Signed in as ${escape(member.name)}.</p>` : ''}`;
export async function browser(req, res, pathname, query, member, auth, artifacts) {
  if (await accounts(req, res, pathname, query, member, auth, { page, nav, escape, nextPath, csrfGuard })) return true;
  if (pathname === '/logout' && req.method === 'GET') {
    res.setHeader('Set-Cookie', await auth.logout(req));
    redirect(res, '/login');
    return true;
  }
  if (pathname === '/devices/add' && ['GET', 'POST'].includes(req.method)) {
    if (!member) { redirect(res, `/login?next=${encodeURIComponent(req.url)}`); return true; }
    const input = req.method === 'POST' ? new URLSearchParams(await body(req)) : query;
    const code = normalizeCode(input.get('code'));
    if (req.method === 'POST') {
      csrfGuard(req, auth.origin());
      try {
        if (input.get('action') === 'add') {
          const result = await auth.approveDevice(code, member);
          page(res, 'Terminal connected', `${nav(member)}<h1>Terminal connected</h1><p><strong>${escape(result.device)}</strong> is now signed in as <strong>${escape(result.member)}</strong>. You can close this page and return to your terminal.</p><pre><code>yeet throw ./result</code></pre>`);
        } else {
          auth.denyDevice(code);
          page(res, 'Denied', `${nav(member)}<h1>Denied</h1><p>That sign-in request was rejected. Nothing was added.</p>`);
        }
      } catch (error) {
        if (!error.status) throw error;
        page(res, 'Add a device', `${nav(member)}<h1>Could not add the device</h1><p>${escape(error.message)}</p><p><a href="/devices/add">Try another code</a></p>`, error.status);
      }
      return true;
    }
    let detail = '';
    if (code) {
      try {
        const request = auth.deviceRequest(code);
        detail = `<p>A sign-in was requested from <strong>${escape(request.device)}</strong> at ${escape(request.createdAt)}. Add it only if that is you or your agent. It will act as <strong>${escape(member.name)}</strong>.</p>`;
      } catch (error) {
        if (!error.status) throw error;
        detail = `<p>${escape(error.message)}. Run <code>yeet login</code> again and enter the new code.</p>`;
      }
    }
    page(res, 'Connect your terminal', `${nav(member)}<h1>Connect your terminal</h1>${detail}<form method="post" action="/devices/add"><label for="code">Check this matches the code in your terminal</label><input id="code" name="code" class="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${escape(code || '')}"><button type="submit" name="action" value="add">Connect this terminal</button><button type="submit" name="action" value="deny">Deny</button></form>`);
    return true;
  }
  if (pathname === '/devices' && req.method === 'GET') {
    if (!member) { redirect(res, `/login?next=${encodeURIComponent(req.url)}`); return true; }
    const tokens = await auth.tokens(member);
    const items = tokens.map(t => `<li><strong>${escape(t.device)}</strong>${member.role === 'admin' ? ` <span class="detail">${escape(t.member)}</span>` : ''}<div class="detail">Added <time datetime="${escape(t.createdAt)}">${escape(t.createdAt)}</time></div><form method="post" action="/devices/${escape(t.id)}/revoke"><button class="small" type="submit">Revoke</button></form></li>`).join('');
    page(res, 'Connected terminals', `${nav(member)}<h1>Connected terminals</h1><p>Each terminal or agent that ran <code>yeet login</code>. Revoking a connection stops it publishing or reading private pages.</p>${items ? `<ul>${items}</ul>` : '<p>No terminals connected yet. <a href="/connect">Connect your first terminal</a>.</p>'}`);
    return true;
  }
  const revoke = /^\/devices\/([a-f0-9]{12})\/revoke$/.exec(pathname);
  if (revoke && req.method === 'POST') {
    if (!member) { redirect(res, '/login?next=%2Fdevices'); return true; }
    csrfGuard(req, auth.origin());
    await auth.revokeToken(revoke[1], member);
    redirect(res, '/devices');
    return true;
  }
  if (pathname === '/' && req.method === 'GET') {
    if (!member) redirect(res, '/login');
    else {
      const values = (await artifacts.list()).filter(value => value.owner === member.name || value.visibility === 'workspace');
      const item = value => `<li><a href="/a/${value.id}/">${escape(value.name || value.id)}</a><div class="detail">${escape(value.visibility)} / v${value.latest}<br>Updated <time datetime="${escape(value.updatedAt)}">${escape(value.updatedAt)}</time></div></li>`;
      // Values arrive newest first, so each project lands in order of its latest page. Unfiled pages go last.
      const groups = Map.groupBy(values, value => value.project || '');
      const described = await artifacts.descriptionsFor(member);
      const sections = [...groups].sort(([a], [b]) => (a === '') - (b === '')).map(([project, pages]) =>
        `<section><h2>${project ? escape(project) : 'No project'} <span class="detail">${pages.length}</span></h2>${described[project] ? `<p class="detail">${escape(described[project].description)}</p>` : ''}<ul>${pages.map(item).join('')}</ul></section>`).join('');
      const unfiled = groups.has('')
        ? '<p class="detail">Pages thrown from a git repository are filed under its name. File older pages with <code>yeet sort</code>.</p>' : '';
      page(res, 'Workspace', `${nav(member)}<h1>Your workspace</h1>${!member.passwordHash ? '<p><a href="/account">Set a password</a> to sign in on other browsers without a token.</p>' : ''}${sections ? unfiled + sections : '<p>No pages yet. <a href="/connect">Connect your terminal</a>, then publish with <code>yeet throw ./result</code>.</p>'}`);
    }
    return true;
  }
  return false;
}
