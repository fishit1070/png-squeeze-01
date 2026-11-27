// PNG codec pieces for the squeeze entry: CRC-32, Adler-32, chunk assembly, the five
// row filters, and a strict decoder that mirrors the contest checker's accepted format
// (bit depth 8, colour types 0/2/3/4/6, chunks IHDR/PLTE/tRNS/IDAT/IEND only).
import { inflateSync } from 'node:zlib';

export const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
export const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const ALLOWED = Object.freeze(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

export function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

export function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

export function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter row `cur` (stride samples, bpp bytes a pixel, `prev` the unfiltered row above or null)
// by `type` into out[0, stride). All arithmetic wraps mod 256 by Uint8Array semantics.
export function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur.subarray(0, n));
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// The minimum-sum heuristic's cost of a filtered row: bytes read as signed, absolute.
export function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

const fail = (why) => ({ ok: false, why });

// Decode a PNG in the contest's accepted format to RGBA bytes, or { ok: false, why }.
// Used both to read the stored input images and to self-verify every answer we write.
export function decodePng(bytes, expect = null) {
  if (!(bytes instanceof Uint8Array)) return fail('not bytes');
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('bad signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return fail('bytes after IEND');
    if (at + 12 > bytes.length) return fail('chunk cut short');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail('bad chunk type');
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail('CRC mismatch in ' + type);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!ALLOWED.includes(type)) return fail('chunk ' + type + ' not allowed');
    if (header === null && type !== 'IHDR') return fail('first chunk not IHDR');
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) return fail('IHDR twice');
      if (len !== 13) return fail('IHDR not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('zero dimension');
      if (expect !== null && (header.width !== expect.width || header.height !== expect.height)) return fail('wrong dimensions');
      if (header.depth !== 8) return fail('bit depth not 8');
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail('bad colour type');
      if (header.compression !== 0 || header.filter !== 0) return fail('bad compression/filter method');
      if (header.interlace !== 0) return fail('interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('PLTE twice');
      if (header.colourType !== 3) return fail('PLTE with non-palette type');
      if (idat.length > 0) return fail('PLTE after IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('bad PLTE size');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('tRNS twice');
      if (idat.length > 0) return fail('tRNS after IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) return fail('tRNS before PLTE');
        if (len > palette.length / 3) return fail('tRNS longer than palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail('bad tRNS size');
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('tRNS sample over 255');
      } else return fail('tRNS with type ' + ct);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('IDAT chunks not consecutive');
      if (header.colourType === 3 && palette === null) return fail('IDAT before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) return fail('IEND not empty');
      ended = true;
    }
  }
  if (!ended) return fail('no IEND');
  if (idat.length === 0) return fail('no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > 1 << 30) return fail('image too large');
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail('IDAT does not inflate: ' + String(err && err.message).split('\n')[0]);
  }
  if (raw.length !== expected) return fail('inflated size mismatch');

  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail('bad filter type');
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}
