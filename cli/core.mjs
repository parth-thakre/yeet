import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class YeetError extends Error {
  constructor(message, code = 3, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const usage = `Usage:
  yeet login [server-url] [--device <name>] [--no-browser]
                                                    sign in and connect this terminal in your browser
  yeet login --origin <url> --token-stdin            paste a device token instead
  yeet open [link-or-id] [--qr|--no-browser]
                                                    open Yeet in a browser, signed in through this terminal
  yeet whoami
  yeet devices                                       list your device tokens
  yeet devices revoke <id>
  yeet throw <file-or-dir> [--name <name>] [--project <name>] [--project-description <text>]
             [--private|--workspace|--public] [--entry <path>] [--new] [--artifact <id-or-url>] [--json]
  yeet project <id-or-url> <name>                    file one page under a project
  yeet describe <project> ["description"]            show or set what a project is
  yeet sort [--all] [--dry-run|--save <plan.json>] [--with <runner>] [--model <id>] [--min-confidence 0.6]
                                                     file your unsorted pages with a cheap model; runner is
                                                     claude, codex, anthropic, openai, openrouter,
                                                     openai-decisions or jev
  yeet sort --apply <plan.json>                      apply a saved plan exactly
  yeet sort --undo                                   put back the pages the last sort moved
  yeet call <id-or-url> [--output <dir>] [--version N]
                                                     download a page; a pinned link downloads that version
  yeet abandon <id-or-url>                           drop an interrupted upload that blocks yeet throw
  yeet visibility <id-or-url> <private|workspace|public>
  yeet info <id-or-url>
  yeet add <name>                                    invite a person: prints a one-time link
  yeet invite <name>                                 new invite link for an existing member
  yeet remove <name>                                 revoke a person everywhere
  yeet members                                       list people
  yeet --version

All commands accept --origin <url>.
YEET_ORIGIN and YEET_TOKEN override ~/.yeet/config.json.
`;

const valueFlags = new Set(['origin', 'token', 'name', 'project', 'entry', 'artifact', 'output', 'version', 'device', 'with', 'model', 'min-confidence', 'project-description', 'save', 'apply']);
const booleanFlags = new Set(['token-stdin', 'no-browser', 'qr', 'private', 'workspace', 'public', 'new', 'json', 'all', 'dry-run', 'undo']);
// Artifact ids are 12 base64url characters and can start with "-"; read one as an argument unless
// it is exactly a known option such as --no-browser.
const known = arg => arg.startsWith('--') && (booleanFlags.has(arg.slice(2)) || valueFlags.has(arg.slice(2)));
const artifactLike = arg => /^[A-Za-z0-9_-]{12}$/.test(arg) && !known(arg);
export function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('-') || artifactLike(arg)) { positional.push(arg); continue; }
    if (!arg.startsWith('--')) throw new YeetError(`unknown option ${arg}; run yeet help`, 1);
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (Object.hasOwn(flags, name)) throw new YeetError(`duplicate option --${name}; run yeet help`, 1);
    if (booleanFlags.has(name)) {
      if (eq >= 0) throw new YeetError(`--${name} takes no value; run yeet help`, 1);
      flags[name] = true;
    } else if (valueFlags.has(name)) {
      const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
      if (!value || (value.startsWith('--') && !artifactLike(value))) throw new YeetError(`--${name} needs a value; run yeet help`, 1);
      flags[name] = value;
    } else throw new YeetError(`unknown option ${arg}; run yeet help`, 1);
  }
  return { flags, positional };
}

export function validateArgs(flags, positional, allowed, count) {
  for (const flag of Object.keys(flags)) {
    if (flag !== 'origin' && !allowed.includes(flag)) throw new YeetError(`--${flag} is not valid for this command; run yeet help`, 1);
  }
  if (positional.length !== count) throw new YeetError('wrong number of arguments; run yeet help', 1);
}

export const home = () => process.env.YEET_HOME || path.join(os.homedir(), '.yeet');

export async function readJson(filename, fallback = {}) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new YeetError(`cannot read ${filename}: ${error.message}; repair or remove this file`, 1);
  }
}

export async function writeJson(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, filename);
  } finally { await rm(temp, { force: true }); }
}

function normalizeOriginLoose(value) { try { return new URL(value).origin; } catch { return null; } }
export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new YeetError('invalid origin: use --origin https://yeet.example', 1); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new YeetError('invalid origin: use only an http(s) origin, without credentials or a path', 1);
  }
  return url.origin;
}

export async function configuration(flags, needsToken = true) {
  const saved = await readJson(path.join(home(), 'config.json'));
  const origin = flags.origin || process.env.YEET_ORIGIN || saved.origin;
  const savedMatches = saved.token && saved.origin && normalizeOriginLoose(saved.origin) === normalizeOriginLoose(origin);
  const token = process.env.YEET_TOKEN || (savedMatches ? saved.token : undefined); // a saved token belongs to its own origin only
  if (needsToken && !token) throw new YeetError('not logged in: run yeet login <server-url> and connect this terminal in your browser', 2);
  if (!origin) throw new YeetError('no server configured: run yeet login https://your-yeet-server', 1);
  return { origin: normalizeOrigin(origin), token };
}

// A copied link may pin a version as /a/<id>/v/<n>/ or /a/<id>/?v=<n>; n is null when it does not.
// Like the server, ?v counts only on the page root, and a /v/<n>/ path wins over it.
export function artifactRef(value, origin) {
  let id = value, pin = null;
  if (/^https?:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); } catch { throw new YeetError('invalid artifact URL; use a Yeet link or artifact id', 1); }
    if (url.origin !== origin) throw new YeetError(`artifact is on ${url.origin}; use --origin ${url.origin} with a token for that workspace`, 1);
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw new YeetError('invalid artifact URL; copy the link again', 1); }
    const match = /^\/a\/([^/]+)(?:\/(.*))?$/.exec(pathname); // decoded first, as the server does
    if (!match) throw new YeetError('invalid artifact URL; expected /a/<id>', 1);
    id = match[1];
    pin = /^v\/([1-9]\d*)(?:\/|$)/.exec(match[2] || '')?.[1] ?? (!match[2] ? url.searchParams.get('v') : null);
    if (pin !== null && !/^[1-9]\d*$/.test(pin)) throw new YeetError('invalid version in that link; copy the link again', 1);
  }
  if (!/^[A-Za-z0-9_-]{12}$/.test(id)) throw new YeetError('invalid artifact id; use the id or link printed by yeet throw', 1);
  return { id, n: pin === null ? null : versionNumber(pin) };
}
export const artifactId = (value, origin) => artifactRef(value, origin).id;

export function versionNumber(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new YeetError('invalid version: use a positive integer with --version', 1);
  }
  return Number(value);
}

export function apiClient(config) {
  return async function request(route, options = {}) {
    const { json, raw = false, signal, ...init } = options;
    const timeout = AbortSignal.timeout(init.method === 'PUT' || raw ? 600_000 : 30_000);
    const headers = { Accept: 'application/json', ...init.headers };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    let response;
    try {
      response = await fetch(`${config.origin}${route}`, {
        ...init, headers, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      throw new YeetError(`request failed: ${error.message}; check the origin and whether the Yeet server is running`);
    }
    if (!response.ok) {
      let detail;
      try { const body = await response.json(); detail = body.error; } catch { /* The status remains useful. */ }
      const auth = response.status === 401 || response.status === 403;
      const next = auth ? 'run yeet login with an active token; add, invite, remove and members need an admin token'
        : response.status === 404 ? 'check the artifact id and whether this member can access it' : 'check the request and server logs, then retry';
      throw new YeetError(`HTTP ${response.status}${detail ? `: ${detail}` : ''}; ${next}`, auth ? 2 : 3, response.status);
    }
    if (raw) return response;
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try { return JSON.parse(text); }
    catch { throw new YeetError('server returned invalid JSON; check the origin and server logs'); }
  };
}
