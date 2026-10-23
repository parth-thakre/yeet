import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { authStore } from './auth.mjs';
import { readJSON } from './store.mjs';

// Offline only: the server uses process-local locks. Never edit its store concurrently.
export async function recoveryLink(env) {
  const data = path.resolve(env.YEET_DATA || './data');
  const origin = new URL(env.YEET_ORIGIN);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== env.YEET_ORIGIN) throw new Error('Set YEET_ORIGIN to the server origin, without a trailing slash.');
  const stored = await readJSON(path.join(data, 'members.json'), null);
  const admin = stored?.members.find(m => m.role === 'admin' && !m.revokedAt);
  if (!admin) throw new Error('No active admin found. Check YEET_DATA. A fresh server prints its setup link on startup.');
  const auth = await authStore({ data, origin: origin.origin });
  return (await auth.invite(admin.name)).inviteUrl;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.slice(2).join(' ') !== '--server-stopped') throw new Error('Stop the Yeet server first, then run node server/recover.mjs --server-stopped with the same YEET_DATA and YEET_ORIGIN.');
    console.log(`Restart Yeet, then open this private one-time password reset link:\n${await recoveryLink(process.env)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
