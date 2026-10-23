import { createWriteStream } from 'node:fs';
import { lstat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { YeetError } from './core.mjs';

// Retain at most one incoming network chunk plus the current 512-byte header.
class TarReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
  }
  async *chunks(size) {
    while (size > 0) {
      if (!this.buffer.length) {
        const next = await this.iterator.next();
        if (next.done) throw new YeetError('truncated download; remove the partial output and run yeet call again');
        this.buffer = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        if (!this.buffer.length) continue;
      }
      const length = Math.min(size, this.buffer.length);
      const chunk = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      size -= length;
      yield chunk;
    }
  }
  async read(size) {
    const result = Buffer.alloc(size);
    let offset = 0;
    for await (const chunk of this.chunks(size)) { chunk.copy(result, offset); offset += chunk.length; }
    return result;
  }
}

function field(header, offset, length) {
  return header.subarray(offset, offset + length).toString('utf8').split('\0', 1)[0];
}
function octal(header, offset, length) {
  const value = field(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new YeetError('invalid tar numeric field; check the server archive');
  const number = parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new YeetError('tar numeric field is too large; check the server archive');
  return number;
}
function archivePath(value) {
  const parts = value.split('/');
  if (!value || value.includes(String.fromCharCode(92)) || parts.some(part => !part || part.startsWith('.')
    || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new YeetError(`unsafe tar path ${JSON.stringify(value)}; download only trusted Yeet archives`);
  }
  return parts;
}

async function safeDirectory(directory) {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new YeetError(`unsafe output directory ${current}; choose a directory without symbolic links`);
    }
  }
}

export async function extractTar(stream, output) {
  const root = path.resolve(output);
  await safeDirectory(root);
  const reader = new TarReader(stream);
  let count = 0;
  try {
    for (;;) {
      const header = await reader.read(512);
      if (header.every(byte => byte === 0)) {
        const end = await reader.read(512);
        if (!end.every(byte => byte === 0)) throw new YeetError('invalid tar end marker; check the server archive');
        break;
      }
      if (field(header, 257, 6) !== 'ustar') throw new YeetError('unsupported archive: expected POSIX ustar from the Yeet server');
      const expected = octal(header, 148, 8);
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== expected) throw new YeetError('tar checksum mismatch; retry the download');
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      const type = header[156];
      if (![0, 48, 53].includes(type)) throw new YeetError('unsafe tar entry type: links and special files are not allowed');
      const relative = `${prefix ? `${prefix}/` : ''}${name}`.replace(type === 53 ? /\/$/ : /$^/, '');
      const parts = archivePath(relative);
      const destination = path.join(root, ...parts);
      const size = octal(header, 124, 12);
      if (size > 200 * 1024 * 1024 || ++count > 1000) throw new YeetError('archive exceeds Yeet limits; check the server archive');
      if (type === 53) {
        if (size) throw new YeetError('invalid tar directory size; check the server archive');
        await safeDirectory(destination);
      } else {
        await safeDirectory(path.dirname(destination));
        // Exclusive creation rejects pre-existing files and symlinks alike.
        const file = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
        let opened = false;
        file.once('open', () => { opened = true; });
        try { await pipeline(Readable.from(reader.chunks(size)), file); }
        catch (error) {
          if (opened) await rm(destination, { force: true });
          if (error.code === 'EEXIST') throw new YeetError(`output file already exists: ${destination}; choose an empty --output directory`);
          throw error;
        }
      }
      await reader.read((512 - size % 512) % 512);
    }
  } finally { await reader.iterator.return?.(); }
  return root;
}
