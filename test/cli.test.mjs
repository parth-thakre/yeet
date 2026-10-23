import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { extractTar } from '../cli/tar.mjs';
import { applyChanges, detectProject, runners, sortPages, summarize, undoLast, windowsCommand } from '../cli/projects.mjs';
import { parseArgs } from '../cli/core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'cli', 'yeet.mjs');
const serverEntry = path.join(root, 'server', 'server.mjs');
const adminToken = 'cli-test-admin-token';

function cleanEnv(home, extra = {}) {
  const env = { ...process.env };
  delete env.YEET_TOKEN;
  delete env.YEET_ORIGIN;
  return { ...env, YEET_HOME: home, ...extra };
}
function run(home, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd || root, env: cleanEnv(home, options.env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(options.stdin || '');
  });
}
function success(result) {
  assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result.stdout.trim();
}
async function freePort() {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill();
  await closed;
}
async function startServer(t, directory) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, YEET_DATA: path.join(directory, 'data'), YEET_PORT: String(port),
      YEET_ADMIN_TOKEN: adminToken, YEET_INSECURE_COOKIE: '1', YEET_ORIGIN: origin,
    },
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let spawnError;
  child.once('error', error => { spawnError = error; });
  t.after(() => stop(child));
  for (let i = 0; i < 200; i++) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`server exited before readiness: ${output}`);
    try { if ((await fetch(`${origin}/healthz`)).ok) return origin; } catch { /* Starting. */ }
    await delay(50);
  }
  throw new Error(`server did not become ready: ${output}`);
}

const originals = new Map([
  ['index.html', Buffer.from('<!doctype html><html><body>CLI proof<img src="assets/proof%20image.png"><video controls playsinline src="demo.mp4"></video></body></html>')],
  ['assets/proof image.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')],
  ['demo.mp4', Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 109, 112, 52, 50, 0, 255, 128, 17])],
]);

test('CLI against the real server', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-cli-'));
  const origin = await startServer(t, directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'admin-home');
  const bobHome = path.join(directory, 'bob-home');
  const bundle = path.join(directory, 'result');
  await mkdir(path.join(bundle, 'assets'), { recursive: true });
  for (const [name, bytes] of originals) await writeFile(path.join(bundle, ...name.split('/')), bytes);
  await writeFile(path.join(bundle, '.secret'), 'never upload');
  await mkdir(path.join(bundle, 'node_modules'));
  await writeFile(path.join(bundle, 'node_modules', 'hidden.js'), 'never upload');
  let url;
  let id;
  let privateId;
  let bobToken;

  await t.test('login with stdin saves configuration; whoami identifies admin', async () => {
    const result = await run(home, ['login', '--origin', origin, '--token-stdin'], { stdin: `${adminToken}\n` });
    success(result);
    assert.equal(result.stdout, '');
    const config = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
    assert.deepEqual(config, { origin, token: adminToken });
    assert.deepEqual(JSON.parse(success(await run(home, ['whoami']))), { name: 'admin', role: 'admin' });
  });

  await t.test('throw streams HTML, PNG, and MP4; printed URL and assets work', async () => {
    const result = await run(home, ['throw', bundle]);
    url = success(result);
    assert.equal(result.stdout, `${url}\n`);
    assert.match(url, new RegExp(`^${origin}/a/[A-Za-z0-9_-]{12}$`));
    id = url.split('/').at(-1);
    const page = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), originals.get('index.html').toString());
    for (const [name, bytes] of originals) {
      const asset = await fetch(`${url}/${name.split('/').map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      assert.equal(asset.status, 200);
      assert.deepEqual(Buffer.from(await asset.arrayBuffer()), bytes);
    }
    const meta = JSON.parse(success(await run(home, ['info', id])));
    assert.equal(meta.versions[0].files.length, 3);
    const sourceKey = createHash('sha256').update(`${os.hostname()}\0${path.resolve(bundle)}`).digest('hex');
    const mapping = JSON.parse(await readFile(path.join(home, 'artifacts.json'), 'utf8'));
    assert.deepEqual(mapping[sourceKey], { id, url, origin });
  });

  await t.test('rethrow reuses URL and JSON reports version 2', async () => {
    const result = await run(home, ['throw', bundle, '--json']);
    const { project, projectDescription, ...next } = JSON.parse(success(result));
    assert.deepEqual(next, { id, url, n: 2, visibility: 'workspace' });
    assert.equal(project, await detectProject(root));
    assert.equal(projectDescription, null);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const meta = JSON.parse(success(await run(home, ['info', `${url}/assets/proof%20image.png`])));
    assert.equal(meta.latest, 2);
    assert.deepEqual(meta.versions.map(version => version.n).sort(), [1, 2]);
  });

  await t.test('private denies bob with 404; workspace visibility grants access', async () => {
    const privateResult = JSON.parse(success(await run(home, ['throw', bundle, '--new', '--private', '--json'])));
    privateId = privateResult.id;
    assert.notEqual(privateId, id);
    assert.equal(privateResult.visibility, 'private');
    const inviteUrl = success(await run(home, ['add', 'bob']));
    assert.ok(inviteUrl.startsWith(`${origin}/join?code=`), inviteUrl);
    // Bob opens the invite on his phone: that browser gets a session cookie, and the link is single use.
    const joined = await fetch(`${origin}/join`, { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ code: new URL(inviteUrl).searchParams.get('code'), password: 'bob-test-password' }), redirect: 'manual' });
    assert.equal(joined.status, 302);
    const bobCookie = joined.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch(`${origin}/api/me`, { headers: { Cookie: bobCookie } })).json()).name, 'bob');
    assert.equal((await fetch(inviteUrl, { redirect: 'manual' })).status, 400, 'invite is single use');
    // Bob's laptop runs yeet login with no token; his phone approves the code it prints.
    const child = spawn(process.execPath, [cli, 'login', origin, '--no-browser', '--device', 'bob-laptop'], { env: cleanEnv(bobHome), stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => stop(child));
    let loginErr = '';
    let loginOut = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { loginOut += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { loginErr += chunk; });
    child.stdin.end();
    let code;
    for (let i = 0; i < 100 && !code; i++) { code = /check code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(loginErr)?.[1]; if (!code) await delay(100); }
    assert.ok(code, loginErr);
    const form = await fetch(`${origin}/devices/add?code=${code}`, { headers: { Cookie: bobCookie } });
    assert.equal(form.status, 200);
    assert.match(await form.text(), /bob-laptop/);
    const approved = await fetch(`${origin}/devices/add`, { method: 'POST', headers: { Cookie: bobCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, action: 'add' }).toString() });
    assert.equal(approved.status, 200);
    const [exitCode] = await once(child, 'close');
    assert.equal(exitCode, 0, loginErr);
    assert.match(loginErr, /Logged in as bob/);
    assert.equal(loginOut, '');
    assert.match(success(await run(bobHome, ['devices'])), /bob-laptop/);
    const denied = await run(bobHome, ['info', privateId]);
    assert.equal(denied.code, 3, denied.stderr);
    assert.match(denied.stderr, /404/);
    assert.equal(denied.stdout, '');
    assert.match(success(await run(home, ['visibility', privateId, 'workspace'])), / workspace$/);
    assert.equal(JSON.parse(success(await run(bobHome, ['info', privateId]))).id, privateId);
  });

  await t.test('bob calls a workspace artifact and receives byte-identical files', async () => {
    const output = path.join(directory, 'received');
    assert.equal(success(await run(bobHome, ['call', privateId, '--output', output])), output);
    for (const [name, bytes] of originals) assert.deepEqual(await readFile(path.join(output, ...name.split('/'))), bytes);
    await assert.rejects(readFile(path.join(output, '.yeet.json')), { code: 'ENOENT' });
    const pinned = path.join(directory, 'pinned');
    success(await run(bobHome, ['call', id, '--version', '1', '--output', pinned]));
    assert.deepEqual(await readFile(path.join(pinned, 'demo.mp4')), originals.get('demo.mp4'));
  });

  await t.test('member remove immediately revokes bob token', async () => {
    assert.match(success(await run(home, ['members'])), /^bob +member +active/m);
    success(await run(home, ['remove', 'bob']));
    const result = await run(bobHome, ['whoami']);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /401|403/);
    assert.equal(result.stdout, '');
  });

  await t.test('public artifact can be fetched and called without a token', async () => {
    const published = JSON.parse(success(await run(home, ['throw', bundle, '--artifact', id, '--public', '--name', 'Public proof', '--json'])));
    assert.equal(published.id, id);
    assert.equal(published.n, 3);
    assert.equal(published.visibility, 'public');
    const response = await fetch(published.url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), originals.get('index.html').toString());
    const output = path.join(directory, 'anonymous');
    success(await run(path.join(directory, 'anonymous-home'), ['call', id, '--origin', origin, '--output', output]));
    assert.deepEqual(await readFile(path.join(output, 'demo.mp4')), originals.get('demo.mp4'));
  });

  await t.test('a pinned link downloads that version; abandon clears an upload that blocks throw', async () => {
    const pages = path.join(directory, 'versions');
    await mkdir(pages);
    await writeFile(path.join(pages, 'index.html'), '<p>one</p>');
    const first = JSON.parse(success(await run(home, ['throw', pages, '--json'])));
    await writeFile(path.join(pages, 'index.html'), '<p>two</p>');
    success(await run(home, ['throw', pages]));
    for (const [i, link] of [`${first.url}/?v=1`, `${first.url}/v/1/`, `${first.url}/v/1/index.html`, `${first.url}/v/%31/`].entries()) {
      const output = path.join(directory, `pin-${i}`);
      success(await run(home, ['call', link, '--output', output]));
      assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), '<p>one</p>', link);
    }
    assert.equal(JSON.parse(success(await run(home, ['info', `${first.url}/v/docs/page.html`]))).id, first.id, 'a folder named v is not a pin');
    const conflict = await run(home, ['call', `${first.url}/v/1/`, '--version', '2']);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /pins version 1, but --version asks for 2/);

    // A throw killed after begin leaves a pending version; the next throw names the way out.
    const begun = await fetch(`${origin}/api/artifacts/${first.id}/versions`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: '{"entry":"index.html"}' });
    assert.equal(begun.status, 201); await begun.text();
    const blocked = await run(home, ['throw', pages]);
    assert.equal(blocked.code, 3);
    assert.match(blocked.stderr, new RegExp(`already pending; if no other yeet throw is running for this page, clear it with yeet abandon ${first.id}`));
    assert.match((await run(home, ['abandon', first.url])).stderr, /Dropped pending version 3/);
    assert.match((await run(home, ['abandon', first.id])).stderr, /No pending upload/);
    assert.equal(success(await run(home, ['throw', pages])), first.url);

    // A long directory name is fine: the archive stores it as the prefix of each file's path.
    const long = path.join(pages, 'd'.repeat(101));
    await mkdir(long);
    await writeFile(path.join(long, 'index.html'), '<p>deep</p>');
    success(await run(home, ['throw', pages]));
    await rm(long, { recursive: true });

    // Names the server would refuse fail before upload. Windows cannot create a device name to try.
    const names = [`${'n'.repeat(101)}.html`, ...(process.platform === 'win32' ? [] : ['aux.txt'])];
    for (const name of names) {
      await writeFile(path.join(pages, name), 'refused');
      const refused = await run(home, ['throw', pages]);
      assert.equal(refused.code, 1, refused.stderr);
      assert.match(refused.stderr, new RegExp(`cannot publish "${name.replace('.', '\\.')}"`));
      await rm(path.join(pages, name));
    }
  });

  await t.test('server sourceKey lookup recovers after the local mapping is removed', async () => {
    await rm(path.join(home, 'artifacts.json'));
    const result = JSON.parse(success(await run(home, ['throw', bundle, '--json'])));
    assert.ok([id, privateId].includes(result.id));
    assert.ok(result.n >= 2);
    const mapped = Object.values(JSON.parse(await readFile(path.join(home, 'artifacts.json'), 'utf8')));
    assert.equal(mapped[0].id, result.id);
  });

  await t.test('throw files pages under their repository; --project and yeet project override it', async () => {
    const detected = await detectProject(root);
    assert.equal((JSON.parse(success(await run(home, ['info', id])))).project, detected);
    assert.match(success(await run(home, ['project', id, 'Docs'])), /  Docs$/);
    success(await run(home, ['throw', bundle, '--artifact', id]));
    assert.equal(JSON.parse(success(await run(home, ['info', id]))).project, 'Docs', 'a detected repo never refiles a page');
    success(await run(home, ['throw', bundle, '--artifact', id, '--project', 'Launch']));
    assert.equal(JSON.parse(success(await run(home, ['info', id]))).project, 'Launch');
    assert.equal((await run(home, ['throw', bundle, '--project', ' '])).code, 1);
  });

  await t.test('a project with no description asks the agent for one; describe and --project-description set it', async () => {
    const first = await run(home, ['throw', bundle, '--artifact', id, '--project', 'Fresh']);
    assert.equal(success(first), url);
    assert.match(first.stderr, /Project "Fresh" has no description yet\. .*yeet describe "Fresh" "<what this project is>"/);
    assert.equal(success(await run(home, ['describe', 'Fresh'])), 'Fresh has no description yet');
    assert.equal(success(await run(home, ['describe', 'Fresh', 'Phone checkout rebuild'])), 'Phone checkout rebuild');
    const again = await run(home, ['throw', bundle, '--artifact', id, '--json']);
    assert.doesNotMatch(again.stderr, /no description/);
    assert.equal(JSON.parse(success(again)).projectDescription, 'Phone checkout rebuild');
    const set = JSON.parse(success(await run(home, ['throw', bundle, '--artifact', id, '--project', 'Launch', '--project-description', 'Launch week pages', '--json'])));
    assert.deepEqual([set.project, set.projectDescription], ['Launch', 'Launch week pages']);
    const loose = path.join(directory, 'no-repo');
    await mkdir(loose);
    await writeFile(path.join(loose, 'index.html'), '<p>loose</p>');
    const refused = await run(home, ['throw', loose, '--project-description', 'orphan'], { cwd: directory });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--project-description needs a project/);
  });

  await t.test('yeet sort files unsorted pages through a local model CLI', async () => {
    // Fake claude and codex binaries answer like the real ones, filing every page they are shown.
    const bin = path.join(directory, 'bin');
    await mkdir(bin);
    const answer = 'const pages = input.split("\\n").filter(line => line.startsWith("{\\"id\\":")).map(line => JSON.parse(line)); const assignments = pages.map(page => ({ id: page.id, project: page.excerpt.includes("Sortable proof") ? "Sorted" : "Other" })).concat({ id: "AAAAAAAAAAAA", project: "Ghost" });';
    const prelude = '#!/usr/bin/env node\nconst fs = require("node:fs"); const input = fs.readFileSync(0, "utf8"); fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");';
    // On Windows they are .cmd shims around a script, like npm-installed CLIs, so the cmd.exe quoting is exercised.
    const fakeBin = async (name, body) => {
      if (process.platform !== 'win32') return writeFile(path.join(bin, name), body, { mode: 0o755 });
      await writeFile(path.join(bin, `${name}.js`), body);
      await writeFile(path.join(bin, `${name}.cmd`), `@node "%~dp0${name}.js" %*\r\n`);
    };
    await fakeBin('claude', `${prelude}\n${answer}\nprocess.stdout.write(JSON.stringify({ is_error: false, result: "", structured_output: { assignments } }));\n`);
    await fakeBin('codex', `${prelude}\n${answer}\nconst out = process.argv[process.argv.indexOf("-o") + 1]; fs.writeFileSync(out, JSON.stringify({ assignments }));\n`);
    const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
    const env = { [pathKey]: `${bin}${path.delimiter}${process.env[pathKey]}`, FAKE_LOG: path.join(directory, 'fake.log') };
    const loose = path.join(directory, 'loose');
    await mkdir(loose);
    await writeFile(path.join(loose, 'index.html'), '<title>Sortable &amp; proof</title><body><script>ignored()</script>Sortable proof</body>');
    const looseId = JSON.parse(success(await run(home, ['throw', loose, '--json'], { cwd: directory }))).id;
    assert.equal(JSON.parse(success(await run(home, ['info', looseId]))).project ?? null, null, 'outside git a page starts unfiled');
    const before = JSON.parse(success(await run(home, ['info', looseId]))).updatedAt;

    const preview = await run(home, ['sort', '--dry-run'], { env });
    assert.match(success(preview), /^Sorted\s+Sortable & proof$/m, 'unnamed pages show their title');
    assert.doesNotMatch(preview.stdout, /Ghost/, 'ids the model invents are ignored');
    assert.match(preview.stderr, /Would file 1 page\. Run without --dry-run/);
    assert.equal(JSON.parse(success(await run(home, ['info', looseId]))).project ?? null, null);
    const [args] = (await readFile(env.FAKE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(args.slice(0, 3), ['-p', '--model', 'claude-haiku-5-5']);
    assert.equal(args[args.indexOf('--tools') + 1], '', 'the model gets no tools');
    assert.equal(JSON.parse(args[args.indexOf('--json-schema') + 1]).required[0], 'assignments', 'the schema argument arrives intact');

    assert.match((await run(home, ['sort'], { env })).stderr, /Filed 1 page\./);
    const sorted = JSON.parse(success(await run(home, ['info', looseId])));
    assert.equal(sorted.project, 'Sorted');
    assert.equal(sorted.updatedAt, before);
    assert.match((await run(home, ['sort'], { env })).stderr, /Every page already has a project/);

    // Walking it back: --undo restores the last applied sort; --save and --apply replay one plan exactly.
    const projectOf = async () => JSON.parse(success(await run(home, ['info', looseId]))).project ?? null;
    const unfile = () => fetch(`${origin}/api/artifacts/${looseId}`, { method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: null }) });
    const undone = await run(home, ['sort', '--undo']);
    assert.match(success(undone), /^\(no project\)\s+Sortable & proof  \(back from Sorted\)$/m);
    assert.match(undone.stderr, /Put back 1 page from the claude-haiku-5-5 sort/);
    assert.equal(await projectOf(), null);
    assert.match((await run(home, ['sort', '--undo'])).stderr, /No sort to undo/, 'each sort is undone once');
    const modelCalls = async () => (await readFile(env.FAKE_LOG, 'utf8')).trim().split('\n').length;
    const plan = path.join(directory, 'plan.json');
    assert.match((await run(home, ['sort', '--save', plan], { env })).stderr, /Saved a plan for 1 page/);
    assert.equal(await projectOf(), null, 'saving a plan changes nothing');
    assert.deepEqual(JSON.parse(await readFile(plan, 'utf8')).changes.map(change => [change.id, change.from, change.project]), [[looseId, null, 'Sorted']]);
    success(await run(home, ['project', looseId, 'Manual']));
    assert.match((await run(home, ['sort', '--apply', plan])).stderr, /Filed 0 pages\. Skipped 1 page refiled since the plan was made/);
    assert.equal(await projectOf(), 'Manual');
    await unfile();
    const callsBefore = await modelCalls();
    const replay = await run(home, ['sort', '--apply', plan]);
    assert.match(replay.stderr, /Filed 1 page\. Undo with yeet sort --undo/);
    assert.equal(await modelCalls(), callsBefore, '--apply never asks the model again');
    success(await run(home, ['project', looseId, 'Manual']));
    assert.match((await run(home, ['sort', '--undo'])).stderr, /Put back 0 pages .* Left 1 page that were refiled since/);
    assert.equal(await projectOf(), 'Manual', 'undo never overwrites a later refile');
    success(await run(home, ['project', looseId, 'Sorted']));
    assert.equal((await run(home, ['sort', '--apply', plan, '--with', 'codex'])).code, 1);
    assert.equal((await run(home, ['sort', '--undo', '--dry-run'])).code, 1);

    const codex = await run(home, ['sort', '--all', '--dry-run', '--with', 'codex', '--model', 'gpt-6-luna'], { env });
    assert.match(success(codex), /^Other\s+.*\(was Launch\)$/m);
    assert.match(codex.stderr, /Asking gpt-6-luna/);
    const codexArgs = (await readFile(env.FAKE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).findLast(line => line[0] === 'exec');
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use']) {
      assert.ok(codexArgs.some((arg, i) => arg === feature && codexArgs[i - 1] === '--disable'), `codex runs with ${feature} off`);
    }
    assert.ok(codexArgs.includes('--ignore-user-config'), 'codex skips user config and its MCP servers');
    assert.ok(codexArgs.includes('web_search="disabled"'), 'quoted config values arrive intact');
    assert.equal((await run(home, ['sort', '--with', 'gemini'], { env })).code, 1);

    // The API runners: a fake Anthropic Messages endpoint and a fake OpenAI Responses endpoint.
    const calls = [];
    const fake = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      calls.push({ url: req.url, headers: req.headers, request });
      res.setHeader('Content-Type', 'application/json');
      // Decision endpoints: sure about the sortable page, unsure about everything else.
      if (req.url === '/v1/decisions' || req.url === '/v1/systemone') {
        const text = request.input ?? request.state;
        const [project, confidence] = text.includes('Sortable proof') ? ['Sorted', 0.91] : ['Launch', 0.3];
        const options = request.questions[0]?.choices ?? Object.entries(request.questions.project.criteria).map(([value, description]) => ({ value, description }));
        assert.ok(options.every(option => typeof option.description === 'string'), 'option descriptions are strings, never null');
        assert.equal(new Set(options.map(option => option.value)).size, options.length, 'option values are unique');
        const answer = { type: 'choice', choice: options.find(option => option.description.startsWith(`Project "${project}".`)).value, confidence };
        res.end(JSON.stringify(req.url === '/v1/decisions' ? { model: request.model, answers: [{ ...answer, name: 'project', probabilities: [] }] } : { model: 'jev-1.13.0', answers: { project: { ...answer, probabilities: {} } } }));
        return;
      }
      const prompt = req.url === '/v1/responses' ? request.input : request.messages[0].content;
      const assignments = prompt.split('\n').filter(line => line.startsWith('{"id":')).map(line => ({ id: JSON.parse(line).id, project: 'Via API' }));
      const answer = JSON.stringify({ assignments });
      if (req.url === '/api/v1/chat/completions') { res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: answer } }] })); return; }
      res.end(JSON.stringify(req.url === '/v1/messages'
        ? { stop_reason: 'end_turn', content: [{ type: 'text', text: answer }] }
        : { status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Here you go:' }] }, { type: 'message', content: [{ type: 'output_text', text: answer }] }] }));
    });
    fake.listen(0, '127.0.0.1');
    await once(fake, 'listening');
    t.after(() => fake.close());
    const api = `http://127.0.0.1:${fake.address().port}`;
    assert.equal((await run(home, ['sort', '--all', '--dry-run', '--with', 'anthropic'], { env: { ...env, ANTHROPIC_API_KEY: '' } })).code, 2, 'a missing key says which variable to set');
    const viaAnthropic = await run(home, ['sort', '--all', '--dry-run', '--with', 'anthropic'], { env: { ...env, ANTHROPIC_API_KEY: 'test-anthropic', ANTHROPIC_BASE_URL: api } });
    assert.match(success(viaAnthropic), /^Via API\s+Sortable & proof\s+\(was Sorted\)$/m);
    const messages = calls.at(-1);
    assert.equal(messages.headers['x-api-key'], 'test-anthropic');
    assert.equal(messages.request.model, 'claude-haiku-5-5');
    assert.equal(messages.request.output_config.format.type, 'json_schema');
    const viaOpenAI = await run(home, ['sort', '--all', '--dry-run', '--with', 'openai'], { env: { ...env, OPENAI_API_KEY: 'test-openai', OPENAI_BASE_URL: `${api}/v1` } });
    assert.match(success(viaOpenAI), /^Via API\s+Sortable & proof/m, 'skips the extra message item Luna sometimes returns');
    const responses = calls.at(-1);
    assert.equal(responses.url, '/v1/responses');
    assert.equal(responses.headers.authorization, 'Bearer test-openai');
    assert.deepEqual([responses.request.model, responses.request.text.format.type, responses.request.text.format.strict], ['gpt-6-luna', 'json_schema', true]);

    const viaOpenRouter = await run(home, ['sort', '--all', '--dry-run', '--with', 'openrouter'], { env: { ...env, OPENROUTER_API_KEY: 'test-openrouter', OPENROUTER_BASE_URL: `${api}/api/v1` } });
    assert.match(success(viaOpenRouter), /^Via API\s+Sortable & proof/m);
    const routed = calls.at(-1);
    assert.equal(routed.url, '/api/v1/chat/completions');
    assert.equal(routed.headers.authorization, 'Bearer test-openrouter');
    assert.equal(routed.request.model, 'anthropic/claude-haiku-5.5');
    assert.deepEqual(routed.request.provider, { zdr: true, require_parameters: true }, 'OpenRouter only routes to zero-data-retention endpoints');
    assert.deepEqual([routed.request.response_format.type, routed.request.response_format.json_schema.strict], ['json_schema', true]);

    // Decision models only choose among existing projects, and only file pages they are sure about.
    const decisionsRun = await run(home, ['sort', '--all', '--dry-run', '--with', 'openai-decisions'], { env: { ...env, OPENAI_API_KEY: 'test-openai', OPENAI_BASE_URL: `${api}/v1` } });
    assert.equal(success(decisionsRun), '', 'the sortable page is already in Sorted, and the rest are below the threshold');
    assert.match(decisionsRun.stderr, /matched below 0\.6 confidence/);
    const decisions = calls.at(-1);
    assert.equal(decisions.url, '/v1/decisions');
    const [question] = decisions.request.questions;
    assert.deepEqual([decisions.request.model, question.type, question.name], ['gpt-6-luna', 'choice', 'project']);
    assert.ok(question.choices.some(choice => /^Project "Sorted"\. .*Sortable & proof/.test(choice.description)), 'projects are described by their pages');
    assert.ok(question.choices.some(choice => choice.description.startsWith('Project "Launch". Launch week pages')), 'and by their own description');
    assert.equal(question.choices.at(-1).value, 'none');
    const lenient = await run(home, ['sort', '--all', '--dry-run', '--with', 'jev', '--min-confidence', '0.2'], { env: { ...env, TYPESAFE_API_KEY: 'test-typesafe', TYPESAFE_BASE_URL: api } });
    assert.match(success(lenient), /^Launch\s+.+  30%  \(was \S+\)$/m);
    const jev = calls.at(-1);
    assert.equal(jev.url, '/v1/systemone');
    assert.equal(jev.headers.authorization, 'Bearer test-typesafe');
    assert.equal(jev.request.model, 'jev-latest');
    assert.equal(jev.request.questions.project.type, 'choice');
    assert.ok(Object.values(jev.request.questions.project.criteria).some(text => text.startsWith('Project "Sorted".')));
    assert.equal((await run(home, ['sort', '--with', 'jev', '--min-confidence', 'high'], { env })).code, 1);
    const unfiledOnly = async route => route === '/api/artifacts' ? { artifacts: [{ id: 'AAAAAAAAAAAA', latest: 1, project: null }] } : null;
    await assert.rejects(sortPages(unfiledOnly, { runner: 'jev', log: () => {} }), /only picks from existing projects/);
    assert.deepEqual(summarize('<title>A &lt;b&gt;</title><style>x{}</style><p>Hi&#33;  there</p>'), { title: 'A <b>', excerpt: 'A <b> Hi! there' });
  });

  await t.test('environment overrides config and origin flag overrides environment', async () => {
    const rejected = await run(home, ['whoami'], { env: { YEET_TOKEN: 'invalid-token' } });
    assert.equal(rejected.code, 2, rejected.stderr);
    const accepted = await run(home, ['whoami', '--origin', origin], { env: { YEET_ORIGIN: 'http://127.0.0.1:1', YEET_TOKEN: adminToken } });
    assert.equal(JSON.parse(success(accepted)).name, 'admin');
  });
});

test('usage, version, missing authentication, and input validation', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yeet-cli-usage-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const args of [[], ['help'], ['throw', '--made-up'], ['call'], ['whoami', '--json']]) {
    const result = await run(home, args);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr);
  }
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(success(await run(home, ['--version'])), pkg.version);
  const auth = await run(home, ['whoami', '--origin', 'http://127.0.0.1:1']);
  assert.equal(auth.code, 2);
  assert.match(auth.stderr, /run yeet login/);
  const conflict = await run(home, ['throw', home, '--private', '--public']);
  assert.equal(conflict.code, 1);
});

function tarEntry(name, data = Buffer.from('example'), type = '0', prefix = '') {
  const header = Buffer.alloc(512);
  const put = (value, offset, length) => header.write(value, offset, length, 'utf8');
  put(name, 0, 100);
  put('0000600\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  put('00000000000\0', 136, 12);
  header.fill(32, 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  put(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([header, data, Buffer.alloc((512 - data.length % 512) % 512)]);
}
function tarStream(entries) {
  const archive = Buffer.concat([...entries, Buffer.alloc(1024)]);
  return Readable.from((function* () {
    for (let offset = 0; offset < archive.length; offset += 37) yield archive.subarray(offset, offset + 37);
  })());
}

test('login saves positional server URL, ignores foreign approval URLs, and preserves config after denied or expired login', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'yeet-login-cli-'));
  let outcome = 'approved';
  let leakedAuth = false;
  const mock = createServer((req, res) => {
    if (req.url.startsWith('/api/device') && req.headers.authorization) leakedAuth = true;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/device') res.end(JSON.stringify({ userCode: 'ABCD-EFGH', code: 'x'.repeat(32), verifyUrl: 'https://attacker.invalid/', expiresIn: 60, interval: 0.01 }));
    else if (req.url.startsWith('/api/device/')) {
      if (outcome === 'expired') { res.statusCode = 404; res.end('{}'); }
      else res.end(JSON.stringify({ status: outcome, token: 'new-device-token' }));
    } else if (req.url === '/api/me') res.end(JSON.stringify({ name: 'alice', role: 'member' }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(async () => { await new Promise(resolve => mock.close(resolve)); await rm(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${mock.address().port}`;
  const result = await run(home, ['login', origin, '--no-browser'], { env: { YEET_TOKEN: 'do-not-send-to-anonymous-endpoints' } });
  success(result);
  assert.equal(leakedAuth, false);
  assert.ok(result.stderr.includes(`${origin}/devices/add?code=ABCD-EFGH`));
  assert.ok(!result.stderr.includes('attacker.invalid'));
  const saved = await readFile(path.join(home, 'config.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved), { origin, token: 'new-device-token' });
  for (outcome of ['denied', 'expired']) {
    const failure = await run(home, ['login', '--no-browser']);
    assert.equal(failure.code, 2); assert.match(failure.stderr, /denied|expired/);
    assert.equal(await readFile(path.join(home, 'config.json'), 'utf8'), saved);
  }
  assert.equal((await run(home, ['login', origin, '--origin', origin, '--no-browser'])).code, 1);
  assert.equal((await run(home, ['login', 'file:///tmp', '--no-browser'])).code, 1);
});

test('tar reader streams files, handles ustar prefixes, and rejects unsafe entries', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-cli-tar-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from(Array.from({ length: 1407 }, (_, index) => index % 256));
  const output = path.join(directory, 'valid');
  await extractTar(tarStream([tarEntry('nested/', Buffer.alloc(0), '5'), tarEntry('demo.mp4', bytes, '0', 'nested')]), output);
  assert.deepEqual(await readFile(path.join(output, 'nested', 'demo.mp4')), bytes);
  const unsafe = ['../escape.html', '/escape.html', 'C:/escape.html', 'nested/../../escape.html', '.yeet.json', 'CON', 'bad:stream', `nested${String.fromCharCode(92)}escape.html`];
  for (let i = 0; i < unsafe.length; i++) {
    await assert.rejects(extractTar(tarStream([tarEntry(unsafe[i])]), path.join(directory, `unsafe-${i}`)), /unsafe tar path/);
  }
  await assert.rejects(extractTar(tarStream([tarEntry('link', Buffer.alloc(0), '2')]), path.join(directory, 'link')), /unsafe tar entry type/);
  await assert.rejects(extractTar(tarStream([tarEntry('nested/demo.mp4', bytes)]), output), /already exists/);
  assert.deepEqual(await readFile(path.join(output, 'nested', 'demo.mp4')), bytes);
  const truncated = Readable.from([tarEntry('incomplete', bytes).subarray(0, 600)]);
  await assert.rejects(extractTar(truncated, path.join(directory, 'truncated')), /truncated download/);
  await assert.rejects(readFile(path.join(directory, 'truncated', 'incomplete')), { code: 'ENOENT' });
  const outside = path.join(directory, 'outside');
  const linked = path.join(directory, 'linked');
  await mkdir(outside);
  await mkdir(linked);
  try { await symlink(outside, path.join(linked, 'jump'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(extractTar(tarStream([tarEntry('jump/escape.html')]), linked), /unsafe output directory/);
  await assert.rejects(readFile(path.join(outside, 'escape.html')), { code: 'ENOENT' });
});

test('failed file upload abandons the pending version and prints no success URL', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-cli-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = path.join(directory, 'index.html');
  await writeFile(html, '<h1>Cleanup</h1>');
  let abandoned = false;
  let sawUpload = false;
  let origin;
  const server = createServer(async (request, response) => {
    for await (const unused of request) { /* Consume the streamed body. */ }
    response.setHeader('Content-Type', 'application/json');
    const route = request.url;
    if (route.startsWith('/api/artifacts?')) return response.end('{"artifacts":[]}');
    if (route === '/api/artifacts' && request.method === 'POST') {
      response.writeHead(201);
      return response.end(JSON.stringify({ id: 'abcdefghijkl', url: `${origin}/a/abcdefghijkl`, visibility: 'workspace', latest: 0 }));
    }
    if (route === '/api/artifacts/abcdefghijkl/versions' && request.method === 'POST') {
      response.writeHead(201);
      return response.end('{"n":1}');
    }
    if (request.method === 'PUT') {
      sawUpload = true;
      response.writeHead(500);
      return response.end('{"error":"simulated upload failure"}');
    }
    if (route === '/api/artifacts/abcdefghijkl/versions/1' && request.method === 'DELETE') {
      abandoned = true;
      response.writeHead(204);
      return response.end();
    }
    response.writeHead(500);
    response.end('{"error":"unexpected request"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  origin = `http://127.0.0.1:${server.address().port}`;
  const result = await run(path.join(directory, 'home'), ['throw', html], { env: { YEET_ORIGIN: origin, YEET_TOKEN: adminToken } });
  assert.equal(result.code, 3, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /500.*simulated upload failure/);
  assert.equal(sawUpload, true);
  assert.equal(abandoned, true);
});

test('rethrow opens a page up only after the new version commits', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-cli-widen-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const html = path.join(directory, 'index.html');
  await writeFile(html, '<h1>Replacement</h1>');
  let failUpload = true;
  const calls = [];
  let origin;
  const page = () => ({ id: 'abcdefghijkl', url: `${origin}/a/abcdefghijkl`, visibility: 'private', latest: 1, project: 'Kept' });
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(`${request.method} ${request.url}${request.method === 'PATCH' ? ` ${body}` : ''}`);
    response.setHeader('Content-Type', 'application/json');
    const route = request.url;
    if (route === '/api/artifacts/abcdefghijkl' && request.method === 'GET') return response.end(JSON.stringify(page()));
    if (route === '/api/artifacts/abcdefghijkl' && request.method === 'PATCH') return response.end(JSON.stringify({ ...page(), ...JSON.parse(body) }));
    if (route === '/api/artifacts/abcdefghijkl/versions' && request.method === 'POST') { response.writeHead(201); return response.end('{"n":2}'); }
    if (request.method === 'PUT') {
      if (failUpload) { response.writeHead(500); return response.end('{"error":"simulated upload failure"}'); }
      response.writeHead(201); return response.end('{"path":"index.html","bytes":20}');
    }
    if (route.endsWith('/commit')) return response.end(JSON.stringify({ id: 'abcdefghijkl', url: `${origin}/a/abcdefghijkl`, n: 2, latest: 2 }));
    if (request.method === 'DELETE') { response.writeHead(204); return response.end(); }
    if (route.startsWith('/api/projects/')) return response.end('{"name":"Kept","description":"Kept pages"}');
    response.writeHead(500);
    response.end('{"error":"unexpected request"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  origin = `http://127.0.0.1:${server.address().port}`;
  const env = { YEET_ORIGIN: origin, YEET_TOKEN: adminToken };
  const home = path.join(directory, 'home');

  const failed = await run(home, ['throw', html, '--artifact', 'abcdefghijkl', '--public'], { env });
  assert.equal(failed.code, 3, failed.stderr);
  assert.ok(!calls.some(call => call.startsWith('PATCH')), `the old version stayed private: ${calls.join(', ')}`);

  calls.length = 0;
  failUpload = false;
  const published = JSON.parse(success(await run(home, ['throw', html, '--artifact', 'abcdefghijkl', '--public', '--json'], { env })));
  assert.equal(published.visibility, 'public');
  const commit = calls.findIndex(call => call.endsWith('/commit'));
  const widen = calls.findIndex(call => call === 'PATCH /api/artifacts/abcdefghijkl {"visibility":"public"}');
  assert.ok(commit >= 0 && widen > commit, calls.join(', '));
});

test('sort reads only the start of each page and says which pages it could not read', async t => {
  let pulled = 0;
  const endless = new ReadableStream({ pull(controller) { pulled += 65536; controller.enqueue(new Uint8Array(65536).fill(97)); } });
  const api = async route => {
    if (route === '/api/artifacts') return { artifacts: [{ id: 'AAAAAAAAAAAA', name: 'Huge', latest: 1, project: null }, { id: 'BBBBBBBBBBBB', name: 'Broken', latest: 1, project: null }] };
    if (route === '/a/AAAAAAAAAAAA/') return new Response(endless);
    throw new Error('HTTP 500');
  };
  t.mock.method(runners.anthropic, 'ask', async () => ({ assignments: [] }));
  const logs = [];
  await sortPages(api, { runner: 'anthropic', log: line => logs.push(line) });
  assert.ok(pulled < 2 * 1024 * 1024, `read ${pulled} bytes of an endless page`);
  assert.ok(logs.some(line => /Could not read Broken \(HTTP 500\); sorting it by its name only/.test(line)), logs.join('\n'));
});

test('artifact ids that start with a dash are arguments, not options', () => {
  assert.deepEqual(parseArgs(['info', '-2G-J-D-gel9']), { flags: {}, positional: ['info', '-2G-J-D-gel9'] });
  assert.deepEqual(parseArgs(['throw', 'out', '--artifact', '--x9_AbCdEfG']).flags, { artifact: '--x9_AbCdEfG' });
  assert.deepEqual(parseArgs(['open', '--no-browser']).flags, { 'no-browser': true }, 'a 12-character option is still an option');
  assert.throws(() => parseArgs(['-x']), /unknown option -x/);
});

test('Windows runs .exe CLIs directly and quotes arguments for .cmd shims', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-wincmd-'));
  try {
    await writeFile(path.join(directory, 'codex.CMD'), '');
    await writeFile(path.join(directory, 'claude.EXE'), '');
    const env = { PATH: directory, PATHEXT: '.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    assert.deepEqual(windowsCommand('claude', ['-p', '--tools', ''], env), { file: path.join(directory, 'claude.EXE'), args: ['-p', '--tools', ''], options: {} });
    const shim = windowsCommand('codex', ['--tools', '', '{"a":[1]}', 'end\\'], env);
    assert.equal(shim.file, env.ComSpec);
    assert.deepEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(shim.args[3].endsWith(' ^^^"--tools^^^" ^^^"^^^" ^^^"{\\^^^"a\\^^^":^^^[1^^^]}^^^" ^^^"end\\\\^^^""'), shim.args[3]);
    assert.deepEqual(shim.options, { windowsVerbatimArguments: true });
    assert.equal(windowsCommand('missing', [], env), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sort apply and undo survive lost responses, failed retries, and same-moment runs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-journal-'));
  try {
    // A fake server holding each page's project, which can lose a response after committing a change.
    const projects = { AAAAAAAAAAAA: null, BBBBBBBBBBBB: null };
    let failAfter = null, failBefore = null;
    const api = async (route, { json }) => {
      const id = route.split('/').pop();
      if (failBefore === id) { failBefore = null; throw Object.assign(new Error('network'), { status: undefined }); }
      if ((projects[id] ?? null) !== json.expectedProject) throw Object.assign(new Error('moved'), { status: 409 });
      projects[id] = json.project;
      if (failAfter === id) { failAfter = null; throw new Error('response lost'); }
      return {};
    };
    const plan = { origin: 'https://yeet.test', model: 'm', changes: [
      { id: 'AAAAAAAAAAAA', name: 'A', from: null, project: 'Sorted' },
      { id: 'BBBBBBBBBBBB', name: 'B', from: null, project: 'Sorted' }] };

    failAfter = 'BBBBBBBBBBBB';
    await assert.rejects(applyChanges(api, plan, directory), /response lost/);
    assert.deepEqual(projects, { AAAAAAAAAAAA: 'Sorted', BBBBBBBBBBBB: 'Sorted' });
    const [file] = await readdir(directory);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, file), 'utf8')).changes.map(change => change.state), ['applied', 'pending'], 'the log exists before the lost response');

    failBefore = 'BBBBBBBBBBBB';
    await assert.rejects(undoLast(api, plan.origin, directory), /network/);
    assert.deepEqual(projects, { AAAAAAAAAAAA: null, BBBBBBBBBBBB: 'Sorted' });
    projects.AAAAAAAAAAAA = 'Sorted'; // refiled by hand before the retry
    const retry = await undoLast(api, plan.origin, directory);
    assert.deepEqual(retry.restored.map(change => change.id), ['AAAAAAAAAAAA', 'BBBBBBBBBBBB']);
    assert.deepEqual(projects, { AAAAAAAAAAAA: 'Sorted', BBBBBBBBBBBB: null }, 'the retry resumes and leaves the hand refile alone');
    assert.equal(await undoLast(api, plan.origin, directory), null);

    await Promise.all([applyChanges(api, plan, directory), applyChanges(api, { ...plan, changes: [] }, directory)]);
    const beforeLastRun = (await readdir(directory)).sort();
    assert.equal(beforeLastRun.length, 2, 'a run that changed nothing leaves no log');
    await applyChanges(api, { ...plan, changes: plan.changes.map(change => ({ ...change, from: 'Sorted', project: 'Again' })) }, directory);
    // The no-op run can reserve a number before deleting its log. Gaps are valid;
    // the next run must sort after the surviving logs, not fill in those gaps.
    const nextLog = `${String(Number(beforeLastRun.at(-1).slice(0, 8)) + 1).padStart(8, '0')}.json`;
    assert.deepEqual((await readdir(directory)).sort(), [...beforeLastRun, nextLog], 'runs get their own numbered logs in order');
    assert.deepEqual(projects, { AAAAAAAAAAAA: 'Again', BBBBBBBBBBBB: 'Again' });
    await undoLast(api, plan.origin, directory);
    assert.deepEqual(projects, { AAAAAAAAAAAA: 'Sorted', BBBBBBBBBBBB: 'Sorted' }, 'undo takes the newest run first');

    // A run that stops before reaching a page never undoes that page.
    const fresh = await mkdtemp(path.join(os.tmpdir(), 'yeet-journal-'));
    Object.assign(projects, { AAAAAAAAAAAA: null, BBBBBBBBBBBB: 'Sorted' }); // B filed by hand
    failBefore = 'AAAAAAAAAAAA';
    await assert.rejects(applyChanges(api, plan, fresh), /network/);
    await undoLast(api, plan.origin, fresh);
    assert.deepEqual(projects, { AAAAAAAAAAAA: null, BBBBBBBBBBBB: 'Sorted' }, 'B was never attempted, so undo leaves it');
    await rm(fresh, { recursive: true, force: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sort undo handles consecutive logs and a gap left by a no-op run', async t => {
  for (const gap of [false, true]) {
    await t.test(gap ? 'a no-op reserves the next number' : 'no number is reserved', async t => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-journal-order-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      let project = null;
      const api = async (route, { json }) => {
        if (project !== json.expectedProject) throw Object.assign(new Error('moved'), { status: 409 });
        project = json.project;
      };
      const plan = { origin: 'https://yeet.test', model: 'm', changes: [
        { id: 'AAAAAAAAAAAA', name: 'A', from: null, project: 'Sorted' }] };
      await applyChanges(api, plan, directory);
      const reserved = path.join(directory, '00000002.json');
      // Hold the no-op's reservation until the changing run has allocated its log,
      // so this ordering is covered on every platform without relying on timing.
      if (gap) await writeFile(reserved, JSON.stringify({ ...plan, changes: [] }), { flag: 'wx' });
      await applyChanges(api, { ...plan, changes: [{ ...plan.changes[0], from: 'Sorted', project: 'Again' }] }, directory);
      if (gap) await rm(reserved);
      assert.deepEqual((await readdir(directory)).sort(), ['00000001.json', gap ? '00000003.json' : '00000002.json']);
      assert.equal(project, 'Again');
      assert.equal((await undoLast(api, plan.origin, directory)).restored.length, 1);
      assert.equal(project, 'Sorted', 'undo chooses the newest surviving log');
      assert.equal((await undoLast(api, plan.origin, directory)).restored.length, 1);
      assert.equal(project, null, 'the older log remains independently undoable');
      assert.equal(await undoLast(api, plan.origin, directory), null);
    });
  }
});
