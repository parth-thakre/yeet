#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { YeetError, usage, parseArgs, validateArgs, home, readJson, writeJson,
  configuration, apiClient, artifactId, artifactRef, versionNumber } from './core.mjs';
import { collectFiles } from './files.mjs';
import { extractTar } from './tar.mjs';
import { openBrowser } from './browser.mjs';
import { qrTerminal } from './qr.mjs';
import { applyChanges, detectProject, projectName, runners, sortPages, undoLast } from './projects.mjs';

const printJson = value => console.log(JSON.stringify(value, null, 2));
const visibilities = ['private', 'workspace', 'public'];

async function login(flags, args) {
  if (args.length > 1) throw new YeetError('use yeet login [server-url]', 1);
  if (args.length && flags.origin) throw new YeetError('supply the server URL once, either after login or with --origin', 1);
  if (args.length) flags.origin = args[0];
  validateArgs(flags, [], ['token', 'token-stdin', 'device', 'no-browser'], 0);
  if (flags.token && flags['token-stdin']) throw new YeetError('choose --token or --token-stdin, not both', 1);
  const config = await configuration(flags, false);
  if (flags.token) config.token = flags.token;
  else if (flags['token-stdin']) {
    let token = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      token += chunk;
      if (token.length > 16_384) throw new YeetError('token input is too long; pipe only your token to --token-stdin', 1);
    }
    config.token = token.trim();
    if (!config.token) throw new YeetError('no token supplied on stdin', 2);
  } else {
    // Device-code flow: this terminal shows a code, an already logged-in browser approves it.
    const anonymous = apiClient({ origin: config.origin });
    const device = flags.device || os.hostname();
    const request = await anonymous('/api/device', { method: 'POST', json: { device } });
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(request.userCode) || !/^[A-Za-z0-9_-]{20,}$/.test(request.code)) throw new YeetError('server returned an invalid login code');
    // Build the URL locally. Never open an arbitrary verifyUrl returned by a server.
    const verifyUrl = `${config.origin}/devices/add?code=${encodeURIComponent(request.userCode)}`;
    console.error(`Connect this terminal to ${config.origin}\n\n  ${verifyUrl}\n\nSign in if asked, check code ${request.userCode} for "${device}", then choose Connect this terminal.\nWaiting up to ${Math.round(request.expiresIn / 60)} minutes. Press Ctrl+C to cancel.`);
    if (!flags['no-browser'] && !(await openBrowser(verifyUrl))) console.error('Could not open a browser. Open the link above on any browser instead.');
    const deadline = Date.now() + request.expiresIn * 1000;
    let failures = 0;
    for (;;) {
      await sleep((request.interval || 3) * 1000);
      if (Date.now() > deadline) throw new YeetError('login code expired; run yeet login again', 2);
      let status;
      try { status = await anonymous(`/api/device/${request.code}`); failures = 0; }
      catch (error) {
        if (error.status === 404) throw new YeetError('login code expired or unknown; run yeet login again', 2);
        if (error.status || ++failures > 10) throw error; // network blips: keep polling for a while
        console.error(`waiting for the server (${error.message})`);
        continue;
      }
      if (status.status === 'approved') { config.token = status.token; break; }
      if (status.status === 'denied') throw new YeetError('login was denied from the browser', 2);
    }
  }
  const me = await apiClient(config)('/api/me');
  await writeJson(path.join(home(), 'config.json'), config);
  console.error(`Logged in as ${me.name} at ${config.origin}`);
  console.error('Sign in your browser on this machine with: yeet open');
}

function openPath(value, origin) {
  if (!value) return '/';
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new YeetError('invalid link; use a Yeet link, path, or artifact id', 1); }
    if (url.origin !== origin) throw new YeetError(`that link is on ${url.origin}, but this terminal is connected to ${origin}`, 1);
    return url.pathname + url.search + url.hash;
  }
  return `/a/${artifactId(value, origin)}/`;
}

// A connected terminal signs browsers in with one-time links, so no browser needs a password.
async function open(flags, args) {
  if (args.length > 1) throw new YeetError('use yeet open [link-or-id]', 1);
  validateArgs(flags, args, ['qr', 'no-browser'], args.length);
  if (flags.qr && flags['no-browser']) throw new YeetError('choose --qr or --no-browser, not both', 1);
  const config = await configuration(flags);
  const api = apiClient(config);
  const next = openPath(args[0], config.origin);
  async function link() {
    let result;
    try { result = await api('/api/browser-links', { method: 'POST', json: { next } }); }
    catch (error) {
      if (error.status === 404 || error.status === 405) throw new YeetError(`${config.origin} does not support browser sign-in links yet; update the Yeet server`, 3);
      throw error;
    }
    if (!/^[A-Za-z0-9_-]{20,}$/.test(result.code)) throw new YeetError('server returned an invalid sign-in link');
    // Build the URL locally. Never open an arbitrary URL returned by a server.
    return { ...result, url: `${config.origin}/login/link?code=${result.code}` };
  }
  const minutes = seconds => `${Math.round(seconds / 60)} minutes`;
  if (flags.qr || flags['no-browser']) {
    const result = await link();
    console.log(flags.qr ? qrTerminal(result.url) : result.url);
    console.error(`${flags.qr ? 'Scan this with your phone' : 'Open this link in the browser to sign in'} within ${minutes(result.expiresIn)}. It works once and signs that browser in as ${result.member} through "${result.device}". Keep it private.`);
    return;
  }
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new YeetError('no graphical session here (DISPLAY and WAYLAND_DISPLAY are unset); run yeet open from a terminal on the desktop, or use --qr or --no-browser', 1);
  }
  const result = await link();
  if (await openBrowser(result.url)) { console.error(`Opened ${config.origin}${next} in your default browser, signed in as ${result.member}.`); return; }
  console.log(result.url);
  console.error(`Could not open a browser. Open the link above within ${minutes(result.expiresIn)}; it works once.`);
}

// Returns the project's description after applying --project-description, null when it has none,
// or undefined when the server predates project descriptions. Never fails a throw that already landed.
async function describeProject(api, project, text) {
  const route = `/api/projects/${encodeURIComponent(project)}`;
  try {
    const value = text !== undefined ? await api(route, { method: 'PUT', json: { description: text } }) : await api(route);
    return value.description;
  } catch (error) {
    if (error.status === 404) return undefined;
    console.error(`Published, but could not ${text !== undefined ? 'describe' : 'look up'} project "${project}": ${error.message}`);
    return undefined;
  }
}

async function throwArtifact(flags, args) {
  validateArgs(flags, args, ['name', 'project', 'project-description', 'entry', 'artifact', 'private', 'workspace', 'public', 'new', 'json'], 1);
  const selected = visibilities.filter(value => flags[value]);
  if (selected.length > 1) throw new YeetError('choose one of --private, --workspace, or --public', 1);
  const config = await configuration(flags);
  const api = apiClient(config);
  const { absolute, entry, files } = await collectFiles(args[0], flags.entry);
  // An explicit --project always wins; a detected repository only fills in a page that has none.
  const explicit = flags.project !== undefined ? projectName(flags.project) : null;
  const project = explicit || await detectProject(absolute, path.dirname(absolute), process.cwd());
  const sourceKey = createHash('sha256').update(`${os.hostname()}\0${absolute}`).digest('hex');
  const mappingFile = path.join(home(), 'artifacts.json');
  const mapping = await readJson(mappingFile);
  let artifact;
  if (flags.artifact) artifact = await api(`/api/artifacts/${artifactId(flags.artifact, config.origin)}`);
  else if (!flags.new) {
    const saved = mapping[sourceKey];
    if (saved?.origin === config.origin) {
      try { artifact = await api(`/api/artifacts/${artifactId(saved.id, config.origin)}`); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (!artifact) {
      const found = await api(`/api/artifacts?sourceKey=${sourceKey}`);
      artifact = found.artifacts[0];
    }
  }
  if (flags['project-description'] !== undefined && !project && !artifact?.project) throw new YeetError('--project-description needs a project; pass --project <name>', 1);
  // Opening a page up waits for the commit, so a throw that fails never exposes the old version.
  // Closing it down happens first, so the new version is never more visible than asked.
  let widen = null;
  if (!artifact) {
    artifact = await api('/api/artifacts', {
      method: 'POST', json: { sourceKey, visibility: selected[0] || 'workspace', ...(flags.name ? { name: flags.name } : {}), ...(project ? { project } : {}) },
    }).then(created => ({ ...created, project }));
  } else {
    const refile = explicit ? explicit !== artifact.project : project && !artifact.project;
    if (selected.length && visibilities.indexOf(selected[0]) > visibilities.indexOf(artifact.visibility)) widen = selected[0];
    const narrow = selected.length && !widen && selected[0] !== artifact.visibility;
    if (narrow || flags.name || refile) {
      artifact = await api(`/api/artifacts/${artifact.id}`, {
        method: 'PATCH', json: { ...(narrow ? { visibility: selected[0] } : {}), ...(flags.name ? { name: flags.name } : {}), ...(refile ? { project } : {}) },
      });
    }
  }
  const route = `/api/artifacts/${artifact.id}/versions`;
  const controller = new AbortController();
  let interrupted = false;
  let pending;
  let committed = false;
  const interrupt = () => { interrupted = true; controller.abort(); };
  const checkInterrupted = () => { if (interrupted) throw new YeetError('upload interrupted; retry yeet throw when ready'); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    // Let begin finish so an interrupt still leaves us a version number to delete.
    let begun;
    try { begun = await api(route, { method: 'POST', json: { entry } }); }
    catch (error) {
      if (error.status === 409) throw new YeetError(`${error.message.replace(/;.*$/, '')}; if no other yeet throw is running for this page, clear it with yeet abandon ${artifact.id}`);
      throw error;
    }
    pending = versionNumber(begun.n);
    checkInterrupted();
    const progress = files.length > 10 || files.reduce((sum, file) => sum + file.bytes, 0) > 5 * 1024 * 1024;
    for (let i = 0; i < files.length; i++) {
      checkInterrupted();
      const file = files[i];
      if (progress) console.error(`Uploading ${i + 1}/${files.length}: ${file.relative} (${file.bytes} bytes)`);
      const body = createReadStream(file.absolute);
      try {
        const encoded = file.relative.split('/').map(encodeURIComponent).join('/');
        await api(`${route}/${pending}/files/${encoded}`, {
          method: 'PUT', body, duplex: 'half', signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.bytes) },
        });
      } finally { body.destroy(); }
    }
    checkInterrupted();
    const result = await api(`${route}/${pending}/commit`, { method: 'POST' });
    committed = true;
    mapping[sourceKey] = { id: result.id, url: result.url, origin: config.origin };
    try { await writeJson(mappingFile, mapping); }
    catch (error) { console.error(`Uploaded, but could not save the local mapping: ${error.message}; check permissions on ${home()}`); }
    if (widen) {
      try { artifact = await api(`/api/artifacts/${artifact.id}`, { method: 'PATCH', json: { visibility: widen } }); }
      catch (error) { throw new YeetError(`published ${result.url} but could not make it ${widen} (${error.message}); run yeet visibility ${result.url} ${widen}`); }
    }
    const filed = artifact.project ?? null;
    const description = filed ? await describeProject(api, filed, flags['project-description']) : undefined;
    if (filed && description === null) {
      console.error(`Project "${filed}" has no description yet. Add one line saying what it is: yeet describe ${JSON.stringify(filed)} "<what this project is>"`);
    }
    if (flags.json) console.log(JSON.stringify({ id: result.id, url: result.url, n: result.n, visibility: artifact.visibility,
      ...(filed ? { project: filed, projectDescription: description ?? null } : {}) }));
    else console.log(result.url);
  } catch (error) {
    if (pending && !committed) {
      try { await api(`${route}/${pending}`, { method: 'DELETE' }); }
      catch (cleanupError) { console.error(`Could not remove pending version ${pending}: ${cleanupError.message}; clear it with yeet abandon ${artifact.id}`); }
    }
    if (interrupted) throw new YeetError('upload interrupted; retry yeet throw when ready');
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}

async function main(argv) {
  if (argv.length === 1 && argv[0] === '--version') {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(pkg.version);
    return;
  }
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stderr.write(usage);
    process.exitCode = 1;
    return;
  }
  const { flags, positional } = parseArgs(argv);
  const [command, ...args] = positional;
  if (command === 'login') return login(flags, args);
  if (command === 'throw') return throwArtifact(flags, args);
  if (command === 'open') return open(flags, args);
  if (command === 'whoami') {
    validateArgs(flags, args, [], 0);
    return printJson(await apiClient(await configuration(flags))('/api/me'));
  }
  if (command === 'devices') {
    const [action, id] = args;
    const api = apiClient(await configuration(flags));
    if (!action) {
      validateArgs(flags, args, [], 0);
      const { tokens } = await api('/api/tokens');
      for (const t of tokens) console.log(`${t.id}  ${t.member.padEnd(16)} ${t.device.padEnd(24)} created ${t.createdAt}`);
      if (!tokens.length) console.error('no active device tokens');
      return;
    }
    if (action !== 'revoke') throw new YeetError('use yeet devices, or yeet devices revoke <id>', 1);
    validateArgs(flags, args, [], 2);
    if (!/^[a-f0-9]{12}$/.test(id)) throw new YeetError('invalid device id; run yeet devices to list them', 1);
    const result = await api(`/api/tokens/${id}`, { method: 'DELETE' });
    console.error(`revoked device ${result.id}`);
    return;
  }
  if (command === 'project') {
    validateArgs(flags, args, [], 2);
    const config = await configuration(flags);
    const id = artifactId(args[0], config.origin);
    const result = await apiClient(config)(`/api/artifacts/${id}`, { method: 'PATCH', json: { project: projectName(args[1]) } });
    console.log(`${result.url}  ${result.project}`);
    return;
  }
  if (command === 'describe') {
    if (args.length < 1 || args.length > 2) throw new YeetError('use yeet describe <project> ["description"]', 1);
    validateArgs(flags, args, [], args.length);
    const config = await configuration(flags);
    const route = `/api/projects/${encodeURIComponent(projectName(args[0]))}`;
    const result = await apiClient(config)(route, args.length === 2 ? { method: 'PUT', json: { description: args[1] } } : {});
    console.log(result.description ?? `${result.name} has no description yet`);
    return;
  }
  if (command === 'sort') {
    validateArgs(flags, args, ['all', 'dry-run', 'with', 'model', 'min-confidence', 'save', 'apply', 'undo', 'json'], 0);
    const modes = ['save', 'apply', 'undo', 'dry-run'].filter(flag => flags[flag] !== undefined);
    if (modes.length > 1) throw new YeetError(`choose one of --${modes.join(', --')}`, 1);
    if ((flags.apply || flags.undo) && ['all', 'with', 'model', 'min-confidence'].some(flag => flags[flag] !== undefined)) {
      throw new YeetError('--apply and --undo replay a recorded sort; drop the sorting options', 1);
    }
    const config = await configuration(flags);
    const api = apiClient(config);
    const journal = path.join(home(), 'sorts');
    const line = change => `${change.project.padEnd(20)} ${change.name}${change.confidence !== undefined ? `  ${Math.round(change.confidence * 100)}%` : ''}${change.from ? `  (was ${change.from})` : ''}`;
    const plural = n => `${n} page${n === 1 ? '' : 's'}`;
    if (flags.undo) {
      const result = await undoLast(api, config.origin, journal);
      if (!result) { console.error('No sort to undo on this server.'); return; }
      for (const change of result.restored) console.log(`${(change.from ?? '(no project)').padEnd(20)} ${change.name}  (back from ${change.project})`);
      console.error(`Put back ${plural(result.restored.length)} from the ${result.run.model} sort of ${result.run.appliedAt}.${result.skipped.length ? ` Left ${plural(result.skipped.length)} that were refiled since.` : ''}`);
      return;
    }
    let plan;
    if (flags.apply) {
      plan = await readJson(path.resolve(flags.apply), null);
      if (!plan || !Array.isArray(plan.changes)) throw new YeetError(`${flags.apply} is not a sort plan; make one with yeet sort --save`, 1);
      if (plan.origin !== config.origin) throw new YeetError(`that plan is for ${plan.origin}, but this terminal is connected to ${config.origin}`, 1);
    } else {
      const runner = flags.with ?? 'claude';
      const changes = await sortPages(api, { all: flags.all, runner, model: flags.model,
        ...(flags['min-confidence'] !== undefined ? { minConfidence: Number(flags['min-confidence']) } : {}) });
      plan = { origin: config.origin, runner, model: flags.model || runners[runner]?.model, createdAt: new Date().toISOString(), changes };
    }
    if (flags.json) console.log(JSON.stringify(plan, null, 2));
    else for (const change of plan.changes) console.log(line(change));
    if (!plan.changes.length) { console.error('Nothing to change.'); return; }
    if (flags.save) {
      await writeJson(path.resolve(flags.save), plan);
      console.error(`Saved a plan for ${plural(plan.changes.length)} to ${flags.save}. Apply it with yeet sort --apply ${flags.save}`);
      return;
    }
    if (flags['dry-run']) { console.error(`Would file ${plural(plan.changes.length)}. Run without --dry-run to apply, or --save a plan.`); return; }
    const { applied, skipped } = await applyChanges(api, plan, journal);
    console.error(`Filed ${plural(applied.length)}.${skipped.length ? ` Skipped ${plural(skipped.length)} refiled since the plan was made.` : ''}${applied.length ? ' Undo with yeet sort --undo.' : ''}`);
    return;
  }
  if (command === 'abandon') {
    validateArgs(flags, args, [], 1);
    const config = await configuration(flags);
    const api = apiClient(config);
    const id = artifactId(args[0], config.origin);
    const { pending } = await api(`/api/artifacts/${id}`);
    if (pending === undefined) throw new YeetError('this server does not report pending uploads, or the page is not yours; update the Yeet server', 3);
    if (!pending) { console.error('No pending upload on this page.'); return; }
    await api(`/api/artifacts/${id}/versions/${pending}`, { method: 'DELETE' });
    console.error(`Dropped pending version ${pending}. yeet throw can publish this page again.`);
    return;
  }
  if (command === 'info' || command === 'visibility' || command === 'call') {
    validateArgs(flags, args, command === 'call' ? ['output', 'version'] : [], command === 'visibility' ? 2 : 1);
    if (command === 'visibility' && !visibilities.includes(args[1])) throw new YeetError('visibility must be private, workspace, or public', 1);
    const config = await configuration(flags, command === 'visibility');
    const api = apiClient(config);
    const { id, n: pinned } = artifactRef(args[0], config.origin);
    if (command === 'info') return printJson(await api(`/api/artifacts/${id}`));
    if (command === 'visibility') {
      const result = await api(`/api/artifacts/${id}`, { method: 'PATCH', json: { visibility: args[1] } });
      console.log(`${result.url}  ${result.visibility}`);
      return;
    }
    const asked = flags.version ? versionNumber(flags.version) : null;
    if (asked && pinned && asked !== pinned) throw new YeetError(`that link pins version ${pinned}, but --version asks for ${asked}; drop one`, 1);
    const n = asked || pinned || (await api(`/api/artifacts/${id}`)).latest;
    if (!n) throw new YeetError('artifact has no committed version; finish a yeet throw before downloading');
    const response = await api(`/api/artifacts/${id}/versions/${n}/files.tar`, { raw: true });
    const directory = await extractTar(response.body, flags.output || path.join(process.cwd(), id));
    console.log(directory);
    return;
  }
  if (command === 'add' || command === 'invite') {
    validateArgs(flags, args, [], 1);
    const api = apiClient(await configuration(flags));
    const result = command === 'add'
      ? await api('/api/members', { method: 'POST', json: { name: args[0] } })
      : await api(`/api/members/${encodeURIComponent(args[0])}/invite`, { method: 'POST' });
    console.error(`One-time invite for ${result.name}, valid until ${result.expiresAt}. Send it privately; they choose a password and sign in:`);
    console.log(result.inviteUrl);
    return;
  }
  if (command === 'remove') {
    validateArgs(flags, args, [], 1);
    const api = apiClient(await configuration(flags));
    const result = await api(`/api/members/${encodeURIComponent(args[0])}`, { method: 'DELETE' });
    console.error(`removed ${result.name}; their devices and sessions stop working on the next request`);
    return;
  }
  if (command === 'members') {
    validateArgs(flags, args, [], 0);
    const api = apiClient(await configuration(flags));
    const { members } = await api('/api/members');
    for (const m of members) console.log(`${m.name.padEnd(16)} ${m.role.padEnd(7)} ${m.revokedAt ? 'revoked ' + m.revokedAt : 'active'}`);
    return;
  }
  throw new YeetError(`unknown command ${command || ''}; run yeet help`, 1);
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(`yeet: ${error.message}${error instanceof YeetError ? '' : '; check the input, output permissions, and server connection'}`);
  process.exitCode = error instanceof YeetError ? error.code : 3;
}
