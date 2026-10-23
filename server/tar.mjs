import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fail, files, safeFile } from './store.mjs';
import { range } from './serve.mjs';

export function tarPath(value) {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' };
  for (let i = value.length - 1; i > 0; i--) {
    if (value[i] === '/' && Buffer.byteLength(value.slice(0, i)) <= 155 && Buffer.byteLength(value.slice(i + 1)) <= 100) {
      return { name: value.slice(i + 1), prefix: value.slice(0, i) };
    }
  }
  fail(400, 'Path is too long for a POSIX ustar archive');
}
function header(file, timestamp) {
  const buf = Buffer.alloc(512);
  const { name, prefix } = tarPath(file.path);
  const text = (value, offset, length) => buf.write(value, offset, length, 'utf8');
  const octal = (value, offset, length) => text(Math.floor(value).toString(8).padStart(length - 1, '0') + '\0', offset, length);
  text(name, 0, 100); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8);
  octal(file.bytes, 124, 12); octal(timestamp, 136, 12);
  buf.fill(32, 148, 156); text('0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2); text(prefix, 345, 155);
  const checksum = buf.reduce((sum, byte) => sum + byte, 0);
  text(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return buf;
}
export async function serveTar(req, res, root, createdAt, id, n) {
  const list = await files(root);
  for (const file of list) tarPath(file.path);
  const size = list.reduce((sum, file) => sum + 512 + Math.ceil(file.bytes / 512) * 512, 1024);
  const { start, end } = range(req, res, size);
  res.setHeader('Content-Type', 'application/x-tar');
  res.setHeader('Content-Disposition', `attachment; filename="${id}-v${n}.tar"`);
  if (req.method === 'HEAD') { res.end(); return; }
  async function* archive() {
    for (const file of list) {
      yield header(file, Date.parse(createdAt) / 1000);
      yield* createReadStream(await safeFile(root, file.path));
      if (file.bytes % 512) yield Buffer.alloc(512 - file.bytes % 512);
    }
    yield Buffer.alloc(1024);
  }
  async function* selected() {
    let offset = 0;
    for await (const chunk of archive()) {
      const next = offset + chunk.length;
      if (next > start && offset <= end) yield chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset + 1));
      offset = next;
      if (offset > end) break;
    }
  }
  await pipeline(Readable.from(selected()), res);
}
