import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fail, files, locks, now, readJSON, safeFile, validPath, writeJSON } from './store.mjs';
import { owner } from './auth.mjs';
import { tarPath } from './tar.mjs';

const maxFile = 200 * 1024 * 1024;
function projectLabel(value) {
  if (value !== null && typeof value !== 'string') fail(400, 'Project must be a string');
  const project = value?.trim() || null;
  if (project && (project.length > 80 || [...project].some(c => c.charCodeAt(0) <= 31))) fail(400, 'Project must be a short single-line label');
  return project;
}
const maxFiles = 500;
const staleUpload = 30 * 60 * 1000; // ms without progress before a new begin may replace a pending version
const pendingName = /^v([1-9]\d*)\.pending$/;
export async function artifactStore(config) {
  const root = path.join(config.data, 'artifacts');
  await fs.mkdir(root, { recursive: true });
  const lock = locks();
  function directory(id) {
    if (!/^[A-Za-z0-9_-]{12}$/.test(id)) fail(404, 'Not found');
    return path.join(root, id);
  }
  const url = id => `${config.origin}/a/${id}`;
  async function meta(id) {
    const value = await readJSON(path.join(directory(id), 'meta.json'), null);
    if (!value) fail(404, 'Not found');
    return value;
  }
  const save = value => writeJSON(path.join(directory(value.id), 'meta.json'), value);
  function versionRoot(id, n, pending = false) {
    if (!Number.isSafeInteger(n) || n < 1) fail(404, 'Not found');
    return path.join(directory(id), `v${n}${pending ? '.pending' : ''}`);
  }
  async function version(id, n, pending = false) {
    const dir = versionRoot(id, n, pending);
    const manifest = await readJSON(path.join(dir, '.yeet.json'), null);
    if (!manifest) fail(404, 'Not found');
    return { root: dir, ...manifest };
  }
  function properties(input) {
    const result = {};
    if (Object.hasOwn(input, 'visibility')) {
      if (!['private', 'workspace', 'public'].includes(input.visibility)) fail(400, 'Invalid visibility');
      result.visibility = input.visibility;
    }
    if (Object.hasOwn(input, 'name')) {
      if (input.name !== null && typeof input.name !== 'string') fail(400, 'Name must be a string');
      result.name = input.name;
    }
    if (Object.hasOwn(input, 'project')) result.project = projectLabel(input.project);
    return result;
  }
  async function create(member, input) {
    const props = properties(input);
    if (input.sourceKey !== undefined && typeof input.sourceKey !== 'string') fail(400, 'sourceKey must be a string');
    let id;
    for (;;) {
      id = randomBytes(9).toString('base64url');
      if (id.startsWith('-')) continue; // reads as an option on command lines
      try { await fs.mkdir(directory(id)); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const timestamp = now();
    const value = { id, owner: member.name, visibility: 'workspace', createdAt: timestamp, updatedAt: timestamp,
      latest: 0, name: null, project: null, sourceKey: input.sourceKey ?? null, ...props };
    await save(value);
    return { id, url: url(id), visibility: value.visibility, latest: 0 };
  }
  async function list() {
    const values = [];
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{12}$/.test(entry.name)) continue;
      const value = await readJSON(path.join(root, entry.name, 'meta.json'), null);
      if (value) values.push(value);
    }
    return values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function detail(value) {
    const versions = [];
    for (const entry of await fs.readdir(directory(value.id), { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^v[1-9]\d*$/.test(entry.name)) continue;
      const n = Number(entry.name.slice(1));
      const info = await version(value.id, n);
      versions.push({ n, createdAt: info.createdAt, entry: info.entry, files: await files(info.root) });
    }
    const { sourceKey, allocated, ...publicMeta } = value;
    return { ...publicMeta, url: url(value.id), versions: versions.sort((a, b) => a.n - b.n) };
  }
  async function mutate(id, member, action) {
    return lock(id, async () => {
      const value = await meta(id);
      owner(value, member);
      return action(value);
    });
  }
  async function pending(id) {
    const name = (await fs.readdir(directory(id))).find(name => pendingName.test(name));
    return name ? Number(pendingName.exec(name)[1]) : null;
  }
  async function begin(id, member, entry) {
    if (!validPath(entry) || !/\.html?$/i.test(entry)) fail(400, 'Entry must be a safe relative HTML path');
    tarPath(entry);
    return mutate(id, member, async value => {
      const names = await fs.readdir(directory(id));
      const waiting = names.find(name => pendingName.test(name));
      if (waiting) {
        // Uploads stream under this lock and touch the directory when done, so a pending version
        // left idle this long is one nobody is finishing: a killed CLI or a lost response.
        const { mtimeMs } = await fs.stat(path.join(directory(id), waiting));
        if (Date.now() - mtimeMs < staleUpload) fail(409, `Version ${pendingName.exec(waiting)[1]} is already pending`);
        await fs.rm(path.join(directory(id), waiting), { recursive: true });
      }
      // Never hand out a number twice, even after an abandon or a restart: a client that still holds
      // a replaced or abandoned number would otherwise write into, commit, or delete the new upload.
      const n = Math.max(value.latest, value.allocated ?? 0, ...names.filter(name => /^v\d+(?:\.pending)?$/.test(name)).map(name => parseInt(name.slice(1), 10))) + 1;
      value.allocated = n;
      await save(value);
      const dir = versionRoot(id, n, true);
      await fs.mkdir(dir);
      await writeJSON(path.join(dir, '.yeet.json'), { entry, createdAt: now() });
      return { n };
    });
  }
  async function upload(id, n, member, relative, req) {
    if (!validPath(relative)) fail(400, 'Invalid file path');
    tarPath(relative);
    if (Number(req.headers['content-length']) > maxFile) fail(413, 'File exceeds 200 MiB');
    return mutate(id, member, async () => {
      const info = await version(id, n, true);
      const target = path.join(info.root, ...relative.split('/'));
      const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) fail(400, 'Path is not a regular file');
      if (!existing && (await files(info.root)).length >= maxFiles) fail(413, 'Version exceeds 500 files');
      let parent = info.root;
      for (const segment of relative.split('/').slice(0, -1)) {
        parent = path.join(parent, segment);
        await fs.mkdir(parent).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await fs.lstat(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(400, 'Invalid parent directory');
      }
      const temp = path.join(info.root, `.upload-${randomBytes(12).toString('hex')}`);
      const handle = await fs.open(temp, 'wx', 0o600);
      let bytes = 0;
      try {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (bytes > maxFile) fail(413, 'File exceeds 200 MiB');
          await handle.writeFile(chunk);
        }
        await handle.close();
        await fs.rename(temp, target);
      } finally { await handle.close(); await fs.rm(temp, { force: true }); }
      const touched = new Date();
      await fs.utimes(info.root, touched, touched); // progress, for the stale check in begin
      return { path: relative, bytes };
    });
  }
  async function commit(id, n, member) {
    return mutate(id, member, async value => {
      const info = await version(id, n, true);
      let entry;
      try { entry = await fs.stat(await safeFile(info.root, info.entry)); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.status === 404) fail(400, 'Entry file was not uploaded'); throw error; }
      if (!entry.isFile()) fail(400, 'Entry file was not uploaded');
      await fs.rename(info.root, versionRoot(id, n));
      value.latest = n; value.updatedAt = now();
      await save(value);
      return { id, url: url(id), n, latest: n };
    });
  }
  async function abandon(id, n, member) {
    return mutate(id, member, async () => {
      const info = await version(id, n, true);
      await fs.rm(info.root, { recursive: true });
    });
  }
  async function patch(id, member, input) {
    const props = properties(input);
    const expected = Object.hasOwn(input, 'expectedProject') ? projectLabel(input.expectedProject) : undefined;
    return mutate(id, member, async value => {
      // Lets yeet sort move a page only if nobody refiled it since, checked under the artifact lock.
      if (expected !== undefined && (value.project ?? null) !== expected) fail(409, 'The page is in a different project now');
      // Filing a page under a project is housekeeping, not an update; keep its place in the list.
      const touched = Object.keys(props).some(key => key !== 'project');
      Object.assign(value, props, touched ? { updatedAt: now() } : {});
      await save(value);
      return detail(value);
    });
  }
  // Projects exist only as labels on artifacts. This file holds the one thing a label can't:
  // a short description, written by whoever describes the project first or edits it later.
  const projectsFile = path.join(config.data, 'projects.json');
  // Null prototype: project names such as constructor or __proto__ are ordinary keys here.
  const descriptions = async () => Object.assign(Object.create(null), await readJSON(projectsFile, {}));
  // A description stays with its author until they have a non-private page in the project, so
  // describing a private project never shows the text to members who guess or reuse its name.
  async function descriptionsFor(member) {
    const values = await descriptions(), pages = await list(), shown = Object.create(null);
    for (const [name, value] of Object.entries(values)) {
      if (value.updatedBy === member.name || pages.some(page => page.project === name && page.owner === value.updatedBy && page.visibility !== 'private')) shown[name] = value;
    }
    return shown;
  }
  async function project(name, member) {
    const label = projectLabel(name);
    if (!label) fail(400, 'Project name is required');
    const value = (await descriptionsFor(member))[label];
    return { name: label, description: value?.description ?? null, updatedBy: value?.updatedBy ?? null, updatedAt: value?.updatedAt ?? null };
  }
  async function describe(name, member, description) {
    const label = projectLabel(name);
    if (!label) fail(400, 'Project name is required');
    if (description !== null && typeof description !== 'string') fail(400, 'Description must be a string');
    const text = description?.replace(/\s+/g, ' ').trim() || null;
    if (text && text.length > 280) fail(400, 'Description must be 280 characters or fewer');
    return lock('projects.json', async () => {
      const values = await descriptions();
      if (text) values[label] = { description: text, updatedBy: member.name, updatedAt: now() };
      else delete values[label];
      await writeJSON(projectsFile, values);
      return project(label, member);
    });
  }
  return { url, meta, version, create, list, detail, pending, begin, upload, commit, abandon, patch, project, describe, descriptionsFor };
}
