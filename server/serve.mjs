import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fail } from './store.mjs';

// This is a response-header sandbox, not a removable iframe attribute. Keeping
// same-origin allows SameSite cookies on private images/media. Frames, popups,
// forms, workers and script-driven network access remain disabled.
export const artifactCSP = "sandbox allow-scripts allow-same-origin; default-src 'self'; img-src 'self' data: https:; media-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'";
const types = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', mp4: 'video/mp4', webm: 'video/webm',
  mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain',
  md: 'text/markdown', csv: 'text/csv', zip: 'application/zip', woff2: 'font/woff2',
};
export function mime(file) {
  const type = types[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  return type.startsWith('text/') || ['application/json', 'image/svg+xml'].includes(type) ? `${type}; charset=utf-8` : type;
}
export function range(req, res, size) {
  res.setHeader('Accept-Ranges', 'bytes');
  let start = 0, end = size - 1;
  // RFC 7233 defines Range for GET only. HEAD returns the full representation's headers.
  // No representation validators are advertised, so If-Range cannot match.
  if (req.headers.range && req.method === 'GET' && !req.headers['if-range']) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const invalid = () => { res.setHeader('Content-Range', `bytes */${size}`); fail(416, 'Range not satisfiable'); };
    if (!match || (!match[1] && !match[2]) || !size) invalid();
    if (!match[1]) {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) invalid();
      start = Math.max(0, size - suffix);
    } else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(Number(match[2]), size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) invalid();
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', Math.max(0, end - start + 1));
  return { start, end };
}
export function artifactHeaders(res, meta, n) {
  res.setHeader('X-Yeet-Artifact', meta.id);
  res.setHeader('X-Yeet-Version', n);
  res.setHeader('Cache-Control', meta.visibility === 'public' ? 'public, max-age=60' : 'private, no-cache');
}
export async function serveFile(req, res, file, artifact = false) {
  const info = await fs.stat(file);
  if (!info.isFile()) fail(404, 'Not found');
  res.setHeader('Content-Type', mime(file));
  if (artifact) {
    res.setHeader('Content-Security-Policy', artifactCSP); // SVG and others can carry script
    // Different opener policy from account pages severs same-origin opener references.
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  }
  const bounds = range(req, res, info.size);
  if (req.method === 'HEAD' || !info.size) { res.end(); return; }
  await pipeline(createReadStream(file, bounds), res);
}
