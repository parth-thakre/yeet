// Minimal QR Code encoder: byte mode, error correction level M, versions 1-40.
// Follows ISO/IEC 18004 as laid out in Project Nayuki's reference implementation, whose
// notice applies to the parts adapted from it:
//
//   QR Code generator library
//   Copyright (c) Project Nayuki. (MIT License)
//   https://www.nayuki.io/page/qr-code-generator-library
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of
//   this software and associated documentation files (the "Software"), to deal in
//   the Software without restriction, including without limitation the rights to
//   use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
//   the Software, and to permit persons to whom the Software is furnished to do so,
//   subject to the following conditions:
//   - The above copyright notice and this permission notice shall be included in
//     all copies or substantial portions of the Software.
//   - The Software is provided "as is", without warranty of any kind, express or
//     implied, including but not limited to the warranties of merchantability,
//     fitness for a particular purpose and noninfringement. In no event shall the
//     authors or copyright holders be liable for any claim, damages or other
//     liability, whether in an action of contract, tort or otherwise, arising from,
//     out of or in connection with the Software or the use or other dealings in the
//     Software.
const eccPerBlock = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const blockCount = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const levelBits = 0; // M

function rawModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = version => Math.floor(rawModules(version) / 8) - eccPerBlock[version] * blockCount[version];
const bit = (value, i) => ((value >>> i) & 1) !== 0;

function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function divisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = multiply(root, 2);
  }
  return result;
}
function remainder(data, generator) {
  const result = generator.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    generator.forEach((coefficient, i) => { result[i] ^= multiply(coefficient, factor); });
  }
  return result;
}
function interleave(data, version) {
  const blocks = blockCount[version], eccLength = eccPerBlock[version];
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - raw % blocks, shortLength = Math.floor(raw / blocks);
  const generator = divisor(eccLength);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = remainder(block, generator);
    if (i < shortBlocks) block.push(0);
    all.push(block.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]); });
  }
  return result;
}

export function qrMatrix(text, fixedMask) {
  const bytes = [...Buffer.from(text, 'utf8')];
  let version = 1;
  while (4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8) {
    if (++version > 40) throw new Error('text is too long for a QR code');
  }
  const bits = [];
  const append = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  append(4, 4);
  append(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) append(byte, 8);
  const capacity = dataCodewords(version) * 8;
  append(0, Math.min(4, capacity - bits.length));
  append(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; reserved[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
    }
  }
  if (version > 1) {
    const count = Math.floor(version / 7) + 2;
    const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const positions = [6];
    for (let position = size - 7; positions.length < count; position -= step) positions.splice(1, 0, position);
    positions.forEach((x, i) => positions.forEach((y, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
  }
  const format = mask => {
    const value = levelBits << 3 | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const word = (value << 10 | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(word, i));
    set(8, 7, bit(word, 6)); set(8, 8, bit(word, 7)); set(7, 8, bit(word, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(word, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(word, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(word, i));
    set(8, size - 8, true);
  };
  format(0); // reserve the format areas before placing data
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const word = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      set(a, b, bit(word, i)); set(b, a, bit(word, i));
    }
  }

  const codewords = interleave(data, version);
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
        if (!reserved[y][x] && index < codewords.length * 8) {
          modules[y][x] = bit(codewords[index >>> 3], 7 - (index & 7));
          index++;
        }
      }
    }
  }

  const masks = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
  ];
  const applyMask = mask => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!reserved[y][x] && masks[mask](x, y)) modules[y][x] = !modules[y][x];
  };
  const penalty = () => {
    let score = 0, dark = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(modules[i].map(Number).join(''));
      lines.push(modules.map(row => Number(row[i])).join(''));
    }
    for (const line of lines) {
      for (const run of line.match(/0+|1+/g)) if (run.length >= 5) score += run.length - 2;
      for (const pattern of ['10111010000', '00001011101']) for (let at = line.indexOf(pattern); at >= 0; at = line.indexOf(pattern, at + 1)) score += 40;
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (x < size - 1 && y < size - 1 && modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) score += 3;
    }
    return score + (Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1) * 10;
  };
  let best = fixedMask ?? 0, lowest = Infinity;
  for (let mask = 0; fixedMask === undefined && mask < 8; mask++) {
    applyMask(mask); format(mask);
    const score = penalty();
    if (score < lowest) { lowest = score; best = mask; }
    applyMask(mask); // masking is an XOR, so applying it again undoes it
  }
  applyMask(best); format(best);
  return modules;
}

// Two rows per line with half blocks, dark on a forced white background so it scans on dark terminals.
export function qrTerminal(text, quiet = 4) {
  const matrix = qrMatrix(text);
  const size = matrix.length + quiet * 2;
  const dark = (x, y) => matrix[y - quiet]?.[x - quiet] === true;
  const lines = [];
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = dark(x, y), bottom = y + 1 < size && dark(x, y + 1);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join('\n');
}
