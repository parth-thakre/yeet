import { body, fail, redirect } from './store.mjs';
import { admin } from './auth.mjs';

// New account forms require browser provenance. Opaque sandboxed artifact origins are refused.
export function accountGuard(req, auth) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') fail(403, 'Open this form on your Yeet server and try again.');
  if (req.headers.origin !== undefined) {
    if (req.headers.origin !== auth.origin()) fail(403, 'Cross-site request refused');
  } else if (site !== 'same-origin') fail(403, 'Open this form on your Yeet server and try again.');
}

export async function accounts(req, res, pathname, query, member, auth, view) {
  if (!['/setup', '/login', '/login/token', '/login/link', '/join', '/account', '/connect', '/people'].includes(pathname)) return false;
  if (!['GET', 'POST'].includes(req.method)) fail(405, 'Method not allowed');
  const { page, nav, escape, nextPath, csrfGuard } = view;
  const post = req.method === 'POST';
  const input = post ? new URLSearchParams(await body(req, 8192)) : query;
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escape(value || '')}">`;
  const password = (label = 'Password', name = 'password', current = false) => `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="password" autocomplete="${current ? 'current-password' : 'new-password'}" ${current ? '' : 'minlength="12"'} maxlength="256" required>`;
  const username = value => `<label for="name">Username</label><input id="name" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" value="${escape(value || '')}" required>`;
  const form = (action, content, label) => `<form method="post" action="${action}">${content}<button type="submit">${label}</button></form>`;
  const render = (title, content, error) => page(res, title, `${nav(member)}<h1>${title}</h1>${error ? `<p class="error" role="alert">${escape(error.message)}</p>` : ''}${content}`, error?.status || 200);
  const already = () => render('Already signed in', `<p>Continue as <strong>${escape(member.name)}</strong>, or log out to use another account.</p><p><a href="${escape(nextPath(input.get('next')))}">Continue</a></p>`, { status: 409, message: 'This browser is already signed in.' });
  if (['/account', '/connect', '/people'].includes(pathname) && !member) {
    redirect(res, `/login?next=${encodeURIComponent(pathname)}`); return true;
  }

  if (pathname === '/login' || pathname === '/login/token') {
    const legacy = pathname === '/login/token' || input.has('token');
    const next = nextPath(input.get('next'));
    const content = legacy
      ? `<p>For existing installations and automation. Paste a device token, not a password.</p>${form('/login/token', hidden('next', next) + '<label for="token">Device token</label><input id="token" name="token" type="password" autocomplete="off" required>', 'Sign in')}<p><a href="/login">Sign in with a password</a></p>`
      : `<p>Sign in to your workspace.</p>${form('/login', hidden('next', next) + username(input.get('name')) + password('Password', 'password', true), 'Sign in')}<p>New here? Open the invite link your admin sent you.</p><details><summary>Forgot your password?</summary><p>Ask your admin for a reset link. Server owners can use the recovery command in the deployment guide.</p></details><details><summary>Have an existing device token?</summary><p><a href="/login/token?next=${encodeURIComponent(next)}">Use token sign-in</a>, then set a password in Account.</p></details>`;
    if (member && !(legacy && req.headers.authorization !== undefined)) { if (post || input.has('token')) already(); else redirect(res, next); return true; }
    try {
      if (post || (legacy && input.has('token'))) {
        if (legacy) { if (post) csrfGuard(req, auth.origin()); }
        else { accountGuard(req, auth); auth.attempt(req); }
        res.setHeader('Set-Cookie', legacy ? await auth.login(input.get('token')) : await auth.passwordLogin(input.get('name'), input.get('password')));
        redirect(res, next); return true;
      }
    } catch (error) { if (!error.status) throw error; render('Sign in', content, error); return true; }
    render('Sign in', content); return true;
  }
  if (pathname === '/login/link') {
    // `yeet open` launches the browser straight at this link, which browsers label Sec-Fetch-Site: none.
    // Link previews, prefetchers, and links followed from other sites get a confirmation button instead.
    // A browser already signed in as someone else is never switched without asking.
    const code = input.get('code');
    const direct = req.headers['sec-fetch-site'] === 'none' && req.headers['sec-fetch-mode'] === 'navigate';
    try {
      const info = post ? null : await auth.browserLinkInfo(code);
      if (post || (direct && (!member || member.name === info.member))) {
        if (post) accountGuard(req, auth);
        const result = await auth.useBrowserLink(code, req);
        res.setHeader('Set-Cookie', result.cookie); redirect(res, nextPath(result.next)); return true;
      }
      const switching = member && member.name !== info.member ? `<p>This browser is signed in as <strong>${escape(member.name)}</strong>. Continuing signs that account out here.</p>` : '';
      render('Sign in this browser', `<p>Sign in as <strong>${escape(info.member)}</strong> through the terminal connection <strong>${escape(info.device)}</strong>.</p>${switching}${form('/login/link', hidden('code', code), switching ? `Switch to ${escape(info.member)}` : 'Sign in')}`);
    } catch (error) {
      if (!error.status) throw error;
      render('Link not accepted', '<p>Sign-in links work once and expire after two minutes. Run <code>yeet open</code> again.</p>', error);
    }
    return true;
  }
  if (pathname === '/setup' || pathname === '/join') {
    if (member) { already(); return true; }
    const code = input.get('code');
    let info;
    try {
      if (pathname === '/setup') {
        if (!(await auth.setupAvailable(code))) fail(400, 'This setup link is invalid or has already been used. Use the private link in the server console.');
      } else info = await auth.inviteInfo(code);
    } catch (error) { if (!error.status) throw error; render('Link not accepted', '<p>Ask your admin for a new link.</p>', error); return true; }
    const title = pathname === '/setup' ? 'Set up Yeet' : info.reset ? 'Reset your password' : 'Join Yeet';
    const content = `<p>${info ? `Your username is <strong>${escape(info.name)}</strong>.` : 'Create the admin account for this server.'} Choose a password of at least 12 characters.</p>${info?.reset ? '<p>This signs out your other browsers and terminals. Reconnect terminals with <code>yeet login</code>.</p>' : ''}${form(pathname, hidden('code', code) + (info ? '' : username(input.get('name'))) + password(), info?.reset ? 'Reset password and sign in' : 'Create account')}`;
    try {
      if (post) {
        accountGuard(req, auth); auth.attempt(req);
        const cookie = pathname === '/setup' ? await auth.setup(code, input.get('name'), input.get('password')) : (await auth.join(code, input.get('password'))).cookie;
        res.setHeader('Set-Cookie', cookie); redirect(res, '/'); return true;
      }
    } catch (error) { if (!error.status) throw error; render(title, content, error); return true; }
    render(title, content); return true;
  }
  if (pathname === '/account') {
    const content = `<p>Signed in as <strong>${escape(member.name)}</strong>.</p><p>${member.passwordHash ? 'Changing your password signs out other browsers and all connected terminals.' : 'Set a password so you can sign in on any browser. Existing terminal connections will keep working.'}</p>${form('/account', (member.passwordHash ? password('Current password', 'current', true) : '') + password('New password'), 'Save password')}`;
    try {
      if (post) {
        accountGuard(req, auth); auth.attempt(req);
        res.setHeader('Set-Cookie', await auth.changePassword(member, input.get('current'), input.get('password')));
        render('Password saved', '<p>You can now sign in on any browser with your username and password.</p><p><a href="/connect">Connect a terminal</a></p>'); return true;
      }
    } catch (error) { if (!error.status) throw error; render('Account', content, error); return true; }
    render('Account', content); return true;
  }
  if (pathname === '/connect') {
    const command = `yeet login ${auth.origin()}`;
    render('Connect your terminal', `<p>Run this once on the machine where you publish:</p><pre><code>${escape(command)}</code></pre><p>Your browser will open. Check the terminal name and code, then choose <strong>Connect this terminal</strong>.</p><p>Working on a remote machine? Add <code>--no-browser</code> and open the printed link here.</p><p>After connecting, publish with:</p><pre><code>yeet throw ./result</code></pre><p>Yeet remembers this server. Agents running under the same OS account can use that connection too.</p><p>Sign in the browser on that machine without a password:</p><pre><code>yeet open</code></pre><p>Sign in your phone by scanning a code: <code>yeet open --qr</code>.</p><p><a href="/devices">Manage connected terminals</a></p>`); return true;
  }
  if (pathname === '/people') {
    admin(member);
    let notice = '', error;
    if (post) {
      try {
        accountGuard(req, auth);
        const invite = input.get('action') === 'reset' ? await auth.invite(input.get('name')) : await auth.create(input.get('name'));
        notice = `<section><h2>Send this link privately</h2><p>For <strong>${escape(invite.name)}</strong>. Expires in 7 days and works once, when they submit their password.</p><p><a href="${escape(invite.inviteUrl)}">${escape(invite.inviteUrl)}</a></p></section>`;
      } catch (e) { if (!e.status) throw e; error = e; }
    }
    const people = (await auth.list()).filter(p => !p.revokedAt);
    render('People', `${notice}<h2>Invite someone</h2>${form('/people', username(''), 'Create invite link')}<ul>${people.map(p => `<li><strong>${escape(p.name)}</strong> <span class="detail">${escape(p.role)}</span>${form('/people', hidden('name', p.name) + hidden('action', 'reset'), 'New invite / password reset link')}</li>`).join('')}</ul>`, error); return true;
  }
  return false;
}
