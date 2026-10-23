import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './store.mjs';

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
let working = 0;
async function key(password, salt) {
  if (working >= 4) fail(429, 'Too many sign-in requests. Try again shortly.');
  working++;
  try { return await derive(password, salt, 32, options); }
  finally { working--; }
}
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    fail(400, 'Use a password between 12 and 256 characters.');
  }
}
export async function passwordHash(password) {
  validatePassword(password);
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await key(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const match = /^scrypt:([a-f0-9]{32}):([a-f0-9]{64})$/.exec(stored || '');
  // Unknown accounts still do the same expensive work.
  const actual = await key(password, match?.[1] || '0'.repeat(32));
  return timingSafeEqual(actual, Buffer.from(match?.[2] || '0'.repeat(64), 'hex')) && Boolean(match);
}
export function loginThrottle() {
  const attempts = new Map();
  return client => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const entry = attempts.get(client) || { count: 0, until: now + 15 * 60_000 };
    if (entry.count >= 20 || (!attempts.has(client) && attempts.size >= 10000)) {
      fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    }
    entry.count++;
    attempts.set(client, entry);
  };
}
