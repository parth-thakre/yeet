import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

test('the npm package includes security docs but no local deployment state', {
  skip: !process.env.npm_execpath && 'run through npm test to check packaging',
}, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yeet-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Do not read deploy/ wholesale: a working checkout may have private data,
  // backups or credentials there, owned by a rootless container's mapped UID.
  for (const name of ['package.json', 'README.md', 'LICENSE', 'SECURITY.md',
    'CONTRIBUTING.md', 'SCOPE.md', 'CONTRACT.md', 'server', 'cli', 'skills',
    'deploy/Dockerfile', 'deploy/compose.yaml', 'deploy/cloudflare-tunnel.sh',
    'deploy/.env.example', 'deploy/README.md']) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await cp(path.join(root, name), path.join(directory, name), { recursive: true });
  }
  // A deployment can contain these even when the source checkout is clean.
  const localFiles = ['deploy/.env', 'deploy/data/private-page.html',
    'deploy/cloudflared/credentials.json', 'deploy/cloudflared/config.yml',
    'deploy/cloudflared/cert.pem', 'deploy/data-backup/members.json'];
  for (const name of localFiles) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), 'local deployment fixture, not for distribution\n');
  }
  // Packing local files needs no registry access. Disable background npm requests
  // and allow for cold Windows runners instead of timing out after 30 seconds.
  const { stdout } = await exec(process.execPath, [process.env.npm_execpath,
    'pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--no-audit',
    '--no-fund', '--update-notifier=false'], { cwd: directory, timeout: 90_000 });
  const [manifest] = JSON.parse(stdout);
  const packed = new Set(manifest.files.map(file => file.path));
  for (const name of localFiles) assert.equal(packed.has(name), false, `${name} must stay local`);
  for (const name of ['LICENSE', 'README.md', 'SECURITY.md', 'CONTRIBUTING.md',
    'cli/yeet.mjs', 'server/server.mjs', 'server/public/yeet-v1.css',
    'skills/yeet/SKILL.md', 'deploy/Dockerfile', 'deploy/compose.yaml',
    'deploy/cloudflare-tunnel.sh', 'deploy/.env.example', 'deploy/README.md']) {
    assert.equal(packed.has(name), true, `${name} must be distributed`);
  }
});
