import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export const now = () => new Date().toISOString();
export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
export async function writeJSON(file, value) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}
export function locks() {
  const waiting = new Map();
  return async (key, action) => {
    const previous = waiting.get(key) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    waiting.set(key, next);
    await previous;
    try { return await action(); }
    finally { release(); if (waiting.get(key) === next) waiting.delete(key); }
  };
}
// Reject Windows aliases as well as traversal, even when running on Unix.
export function validPath(value) {
  if (typeof value !== 'string' || !value || /[<>:"|?*]/.test(value) || [...value].some(c => c.charCodeAt(0) <= 31 || c.charCodeAt(0) === 92)) return false;
  return value.split('/').every(part => part && !part.startsWith('.') && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}
export async function safeFile(root, relative) {
  if (!validPath(relative)) fail(404, 'Not found');
  let current = root;
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail(404, 'Not found');
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) fail(404, 'Not found');
  }
  return current;
}
export async function files(root, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, relative));
    else if (entry.isFile()) result.push({ path: relative, bytes: (await fs.stat(path.join(root, relative))).size });
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
export async function body(req, limit = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function jsonBody(req) {
  let value;
  try { value = JSON.parse(await body(req)); }
  catch (error) { if (error.status) throw error; fail(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Expected a JSON object');
  return value;
}
export function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
export function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }
