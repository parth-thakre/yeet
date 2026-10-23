import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { YeetError } from './core.mjs';
import { validPath } from '../server/store.mjs';
import { tarPath } from '../server/tar.mjs';

// The server's own rule, checked before anything is uploaded, so a throw cannot fail halfway on a name.
export function relativePath(value) {
  const normalized = value.replaceAll(String.fromCharCode(92), '/');
  if (!validPath(normalized)) {
    throw new YeetError(`cannot publish ${JSON.stringify(value)}: rename it without dot segments, drive letters, the characters <>:"|?*, a trailing dot or space, or a Windows device name such as aux or con`, 1);
  }
  return normalized;
}

export async function collectFiles(input, entryFlag) {
  const absolute = path.resolve(input);
  let info;
  try { info = await lstat(absolute); }
  catch (error) { throw new YeetError(`cannot open ${absolute}: ${error.message}; check the file or directory path`, 1); }
  const files = [];
  let entry;
  if (info.isSymbolicLink()) throw new YeetError('the input is a symbolic link; throw the actual file or directory instead', 1);
  if (info.isFile()) {
    entry = relativePath(path.basename(absolute));
    if (entryFlag && relativePath(entryFlag) !== entry) throw new YeetError(`a file is its own entry; use --entry ${entry} or omit --entry`, 1);
    files.push({ absolute, relative: entry, bytes: info.size });
  } else if (info.isDirectory()) {
    async function walk(directory, prefix = '') {
      const items = await readdir(directory, { withFileTypes: true });
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        if (item.name.startsWith('.') || item.name === 'node_modules') continue;
        const filename = path.join(directory, item.name);
        const relative = relativePath(`${prefix}${item.name}`);
        if (item.isSymbolicLink()) { console.error(`Skipping symbolic link ${relative}`); continue; }
        if (item.isDirectory()) await walk(filename, `${relative}/`);
        else if (item.isFile()) {
          const stat = await lstat(filename);
          files.push({ absolute: filename, relative, bytes: stat.size });
          if (files.length > 500) throw new YeetError('too many files: keep each throw to 500 files or fewer', 1);
        }
      }
    }
    await walk(absolute);
    if (entryFlag) entry = relativePath(entryFlag);
    else if (files.some(file => file.relative === 'index.html')) entry = 'index.html';
    else {
      const candidates = files.filter(file => !file.relative.includes('/') && /\.html?$/i.test(file.relative));
      if (candidates.length !== 1) throw new YeetError('cannot choose an HTML entry: add index.html or pass --entry <relative-path>', 1);
      entry = candidates[0].relative;
    }
  } else throw new YeetError('input must be a regular HTML file or a directory', 1);
  if (!/\.html?$/i.test(entry)) throw new YeetError('entry must end in .html or .htm; throw an HTML page', 1);
  if (!files.some(file => file.relative === entry)) throw new YeetError(`entry ${entry} is missing or excluded; choose an uploaded HTML file with --entry`, 1);
  for (const file of files) {
    if (file.bytes > 200 * 1024 * 1024) throw new YeetError(`${file.relative} exceeds 200 MiB; use a smaller file`, 1);
    // Only whole file paths go into the archive, so a long directory name alone is fine.
    try { tarPath(file.relative); } catch { throw new YeetError(`cannot publish ${JSON.stringify(file.relative)}: the path is too long; shorten it`, 1); }
  }
  return { absolute, entry, files };
}
