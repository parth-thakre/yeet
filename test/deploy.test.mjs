import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const script = fileURLToPath(new URL('../deploy/cloudflare-tunnel.sh', import.meta.url));
const exec = promisify(execFile);
const available = async command => exec('bash', ['-c', `command -v ${command}`]).then(() => true, () => false);

test('the private data bind mount is relabelled for SELinux container access', async () => {
  const compose = await readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
  // Without :Z, an enforcing SELinux host denies writes even with the correct UID.
  assert.match(compose, /^\s+- \.\/data:\/data:Z\s*$/m);
});

test('the tunnel helper keeps .env private under a permissive umask', {
  skip: process.platform === 'win32' ? 'POSIX permissions only' : !(await available('jq')) && 'needs jq',
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-tunnel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Fake curl answers the Cloudflare API calls the script makes; fake docker does nothing.
  const bin = path.join(directory, 'bin');
  await exec('mkdir', [bin]);
  await writeFile(path.join(bin, 'curl'), `#!/usr/bin/env node
const url = process.argv.findLast(arg => arg.startsWith('https://api.cloudflare.com'));
let result = {};
if (url.includes('/zones?')) result = [{ id: 'zone', account: { id: 'account' } }];
else if (url.includes('/cfd_tunnel?')) result = [{ id: 'tunnel' }];
else if (url.endsWith('/token')) result = Buffer.from(JSON.stringify({ a: 'account', t: 'tunnel', s: 'not-a-secret' })).toString('base64');
else if (url.includes('/dns_records?')) result = [];
console.log(JSON.stringify({ success: true, result }));
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const work = path.join(directory, 'deploy');
  await exec('mkdir', [work]);
  await writeFile(path.join(work, '.env'), 'YEET_ADMIN_TOKEN=keep-this-private\nYEET_ORIGIN=https://old.example\n', { mode: 0o600 });
  await exec('bash', ['-c', 'umask 022; exec bash "$1"', 'tunnel', script], {
    cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CF_API_TOKEN: 'not-a-secret', HOSTNAME: 'yeet.example.com' },
  });
  assert.equal((await stat(path.join(work, '.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(work, '.env'), 'utf8'), `YEET_ADMIN_TOKEN=keep-this-private\nYEET_ORIGIN=https://yeet.example.com\nCLOUDFLARED_UID=${process.getuid()}\n`);
  for (const file of ['config.yml', 'tunnel.json']) assert.equal((await stat(path.join(work, 'cloudflared', file))).mode & 0o077, 0, file);
  assert.deepEqual((await exec('ls', ['-A', work])).stdout.trim().split('\n').sort(), ['.env', 'cloudflared'], 'no temporary file is left behind');
});
