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

test('Compose passes the content origin from .env to the server', async () => {
  const compose = await readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /^\s+YEET_CONTENT_ORIGIN: \$\{YEET_CONTENT_ORIGIN:-\}\s*$/m);
});

test('deployment backups stay out of Git without hiding deployment source', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-ignore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await exec('git', ['init', '--quiet', directory]);
  await writeFile(path.join(directory, '.gitignore'), await readFile(new URL('../.gitignore', import.meta.url)));
  const privateFiles = [
    'deploy/data/members.json',
    'deploy/data-backup/members.json',
    'deploy/data-backup-20260101-120000/sessions.json',
    'deploy/data-before-restore/members.json',
    'deploy/data-before-restore-20260101-120000/sessions.json',
  ];
  const { stdout } = await exec('git', ['check-ignore', '--no-index', ...privateFiles], { cwd: directory });
  assert.deepEqual(stdout.trim().split(/\r?\n/), privateFiles);
  await assert.rejects(exec('git', ['check-ignore', '--no-index', 'deploy/README.md', 'deploy/compose.yaml',
    'deploy/Dockerfile', 'deploy/.env.example'], { cwd: directory }), error => error.code === 1 && error.stdout === '');
});

// Runs cloudflare-tunnel.sh against a fake Cloudflare API and a docker that only logs its
// arguments. Returns the work directory, the DNS records created, and the docker calls.
async function runTunnelHelper(t, env, existingEnv) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-tunnel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const records = path.join(directory, 'records.log');
  const dockerLog = path.join(directory, 'docker.log');
  await exec('mkdir', [bin]);
  await writeFile(path.join(bin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const url = args.findLast(arg => arg.startsWith('https://api.cloudflare.com'));
let result = {};
// Only real zones exist, so looking up a public suffix such as co.uk fails like it would on Cloudflare.
if (url.includes('/zones?')) result = ['example.com', 'example.co.uk'].includes(new URL(url).searchParams.get('name'))
  ? [{ id: 'zone', account: { id: 'account' } }] : [];
else if (url.includes('/cfd_tunnel?')) result = [{ id: 'tunnel' }];
else if (url.endsWith('/token')) result = Buffer.from(JSON.stringify({ a: 'account', t: 'tunnel', s: 'not-a-secret' })).toString('base64');
else if (url.includes('/dns_records?')) result = [];
else if (url.endsWith('/dns_records')) fs.appendFileSync(${JSON.stringify(records)}, args[args.indexOf('--data') + 1] + '\\n');
console.log(JSON.stringify({ success: true, result }));
`, { mode: 0o755 });
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(dockerLog)}\n`, { mode: 0o755 });
  const work = path.join(directory, 'deploy');
  await exec('mkdir', [work]);
  await writeFile(path.join(work, '.env'), existingEnv, { mode: 0o600 });
  await exec('bash', ['-c', 'umask 022; exec bash "$1"', 'tunnel', script], {
    cwd: work, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CF_API_TOKEN: 'not-a-secret', HOSTNAME: 'yeet.example.com', ...env },
  });
  const created = (await readFile(records, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line).name);
  const docker = (await readFile(dockerLog, 'utf8')).trim().split('\n');
  return { work, created, docker };
}

const posixWithJq = {
  skip: process.platform === 'win32' ? 'POSIX permissions only' : !(await available('jq')) && 'needs jq',
};

test('the tunnel helper keeps .env private under a permissive umask', posixWithJq, async t => {
  const { work, created, docker } = await runTunnelHelper(t, {},
    'YEET_ADMIN_TOKEN=keep-this-private\nYEET_ORIGIN=https://old.example\nYEET_CONTENT_ORIGIN=https://old-content.example\n');
  assert.equal((await stat(path.join(work, '.env'))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(work, '.env'), 'utf8'), 'YEET_ADMIN_TOKEN=keep-this-private\n'
    + 'YEET_ORIGIN=https://yeet.example.com\nYEET_CONTENT_ORIGIN=https://yeet-content.example.com\n'
    + `CLOUDFLARED_UID=${process.getuid()}\n`);
  for (const file of ['config.yml', 'tunnel.json']) assert.equal((await stat(path.join(work, 'cloudflared', file))).mode & 0o077, 0, file);
  assert.deepEqual((await exec('ls', ['-A', work])).stdout.trim().split('\n').sort(), ['.env', 'cloudflared'], 'no temporary file is left behind');
  // Both hostnames reach the same Yeet port, and the content one comes before the catch-all.
  assert.deepEqual(created, ['yeet.example.com', 'yeet-content.example.com']);
  const config = await readFile(path.join(work, 'cloudflared', 'config.yml'), 'utf8');
  assert.ok(config.endsWith(['ingress:', '  - hostname: yeet.example.com', '    service: http://yeet:3000',
    '  - hostname: yeet-content.example.com', '    service: http://yeet:3000', '  - service: http_status:404', ''].join('\n')), config);
  // A running connector reads config.yml only at startup, so the helper must recreate it.
  assert.deepEqual(docker, ['compose --env-file .env --profile cloudflare up -d --wait',
    'compose --env-file .env --profile cloudflare up -d --wait --no-deps --force-recreate cloudflared']);
});

test('the tunnel helper keeps a ZONE_NAME override for the content hostname', posixWithJq, async t => {
  const { work, created } = await runTunnelHelper(t, { HOSTNAME: 'yeet.example.co.uk', ZONE_NAME: 'example.co.uk' }, '');
  assert.deepEqual(created, ['yeet.example.co.uk', 'yeet-content.example.co.uk']);
  assert.equal(await readFile(path.join(work, '.env'), 'utf8'), 'YEET_ORIGIN=https://yeet.example.co.uk\n'
    + `YEET_CONTENT_ORIGIN=https://yeet-content.example.co.uk\nCLOUDFLARED_UID=${process.getuid()}\n`);
});

test('the tunnel helper can skip the content hostname', posixWithJq, async t => {
  const { work, created } = await runTunnelHelper(t, { CONTENT_HOSTNAME: 'none' },
    'YEET_ORIGIN=https://old.example\nYEET_CONTENT_ORIGIN=https://old-content.example\n');
  assert.equal(await readFile(path.join(work, '.env'), 'utf8'),
    `YEET_ORIGIN=https://yeet.example.com\nCLOUDFLARED_UID=${process.getuid()}\n`);
  assert.deepEqual(created, ['yeet.example.com']);
  assert.doesNotMatch(await readFile(path.join(work, 'cloudflared', 'config.yml'), 'utf8'), /content/);
});
