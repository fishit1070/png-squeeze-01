// Deflate stage: turn tokenised data into a complete zlib stream. Blocks of at most
// BLOCK bytes of input are cut from the token stream; each block is written stored,
// with the fixed Huffman codes, or with dynamic Huffman codes built from its own
// frequencies (package-merge length limiting), whichever is smallest by exact bit
// count. Also exposes Node's zlib at level 9 as a candidate: the pipeline keeps the
// smallest stream it is offered, so the custom deflater can only ever help.
import { deflateSync, constants } from 'node:zlib';
import { adler32 } from './png.mjs';
import { createMatcher, greedyTokens, enrichMatcher, tokenise, statsFromTokens, lenCodeIndex, distCodeIndex, LEN_EXTRA, DIST_EXTRA } from './lz77.mjs';

const BLOCK = 262144;

// ---- bit writer (LSB-first, as deflate packs bits) ----
class BitWriter {
  constructor() {
    this.bytes = [];
    this.acc = 0;
    this.nbits = 0;
  }
  bits(value, count) {
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  align() {
    if (this.nbits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.nbits = 0;
    }
  }
  finish() {
    this.align();
    return Uint8Array.from(this.bytes);
  }
}

// ---- Huffman code construction ----

// Length-limited Huffman code lengths for `freq` (package-merge). Symbols with zero
// frequency get length 0. When only one symbol is used it gets length 1.
export function codeLengths(freq, maxLen) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  // Package-merge over items sorted by frequency.
  const byFreq = used.slice().sort((a, b) => freq[a] - freq[b] || a - b);
  let level = byFreq.map((s) => ({ w: freq[s], syms: [s] }));
  for (let iter = 1; iter < maxLen; iter++) {
    const packaged = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      packaged.push({ w: level[i].w + level[i + 1].w, syms: level[i].syms.concat(level[i + 1].syms) });
    }
    const merged = [];
    let a = 0;
    let b = 0;
    const singles = byFreq.map((s) => ({ w: freq[s], syms: [s] }));
    while (a < singles.length || b < packaged.length) {
      if (b >= packaged.length || (a < singles.length && singles[a].w <= packaged[b].w)) merged.push(singles[a++]);
      else merged.push(packaged[b++]);
    }
    level = merged;
  }
  const take = 2 * used.length - 2;
  for (let i = 0; i < take; i++) {
    for (const s of level[i].syms) lengths[s]++;
  }
  return lengths;
}

// Canonical codes from lengths: returns { code, len } per symbol (reversed-bit ready:
// deflate writes Huffman codes MSB-first, so codes are stored bit-reversed).
function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

export function canonicalCodes(lengths) {
  const maxLen = Math.max(...lengths);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const next = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    code = (code + blCount[l - 1]) << 1;
    next[l] = code;
  }
  // A Uint16Array, not lengths.map(): a typed-array map over the Uint8Array lengths
  // would truncate the reversed codes (up to 15 bits) back into single bytes.
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    codes[s] = l === 0 ? 0 : reverseBits(next[l]++, l);
  }
  return codes;
}

const FIXED_LIT_LEN = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

// Exact bit cost of a token list under given code lengths (payload only).
function payloadBits(tokens, litLen, distLen) {
  let bits = 0;
  for (let t = 0; t < tokens.lens.length; t++) {
    if (tokens.lens[t] === 0) bits += litLen[tokens.lits[t]];
    else {
      const li = lenCodeIndex(tokens.lens[t]);
      bits += litLen[257 + li] + LEN_EXTRA[li] + distLen[distCodeIndex(tokens.dists[t])] + DIST_EXTRA[distCodeIndex(tokens.dists[t])];
    }
  }
  return bits + litLen[256];
}

// Run-length encoding of a code-length sequence with symbols 16/17/18.
// Returns a list of [symbol, extraValue, extraBits].
function rleLengths(seq) {
  const out = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    i += run;
    if (v === 0) {
      while (run >= 11) {
        const take = Math.min(run, 138);
        if (take >= 11) {
          out.push([18, take - 11, 7]);
          run -= take;
        }
      }
      while (run >= 3) {
        const take = Math.min(run, 10);
        out.push([17, take - 3, 3]);
        run -= take;
      }
      while (run-- > 0) out.push([0, 0, 0]);
    } else {
      out.push([v, 0, 0]);
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        out.push([16, take - 3, 2]);
        run -= take;
      }
      while (run-- > 0) out.push([v, 0, 0]);
    }
  }
  return out;
}

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// The dynamic-header plan for a block: trimmed lengths, their RLE, the code-length
// code, and the header's exact bit cost; null when the alphabet is degenerate.
function dynamicHeader(litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const seq = [];
  for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
  for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
  const rle = rleLengths(seq);
  const clenFreq = new Float64Array(19);
  for (const [sym] of rle) clenFreq[sym]++;
  const clenLen = codeLengths(clenFreq, 7);
  // Every RLE symbol in use needs a code; a single used symbol is fine at length 1.
  let hclen = 19;
  while (hclen > 4 && clenLen[CLEN_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 14 + hclen * 3;
  for (const [sym, , eb] of rle) bits += clenLen[sym] + eb;
  return { hlit, hdist, hclen, rle, clenLen, bits };
}

function writeDynamicHeader(w, plan, litLen, distLen) {
  w.bits(plan.hlit - 257, 5);
  w.bits(plan.hdist - 1, 5);
  w.bits(plan.hclen - 4, 4);
  for (let i = 0; i < plan.hclen; i++) w.bits(plan.clenLen[CLEN_ORDER[i]], 3);
  const clenCode = canonicalCodes(plan.clenLen);
  for (const [sym, extra, eb] of plan.rle) {
    w.bits(clenCode[sym], plan.clenLen[sym]);
    if (eb > 0) w.bits(extra, eb);
  }
}

function writeTokens(w, tokens, litLen, distLen) {
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  for (let t = 0; t < tokens.lens.length; t++) {
    if (tokens.lens[t] === 0) {
      const s = tokens.lits[t];
      w.bits(litCode[s], litLen[s]);
    } else {
      const li = lenCodeIndex(tokens.lens[t]);
      const s = 257 + li;
      w.bits(litCode[s], litLen[s]);
      if (LEN_EXTRA[li] > 0) w.bits(tokens.lens[t] - [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258][li], LEN_EXTRA[li]);
      const di = distCodeIndex(tokens.dists[t]);
      w.bits(distCode[di], distLen[di]);
      if (DIST_EXTRA[di] > 0) w.bits(tokens.dists[t] - [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577][di], DIST_EXTRA[di]);
    }
  }
  w.bits(litCode[256], litLen[256]);
}

// One block's best encoding: { kind, bits } with kind 'stored' | 'fixed' | 'dynamic'
// and, for the Huffman kinds, the code lengths to write with.
function planBlock(data, start, end, tokens) {
  const storedBits = 32 + (end - start) * 8 + (Math.ceil((end - start) / 65535) - 1) * 40 + 8;
  let best = { kind: 'stored', bits: storedBits };
  const fixedBits = 3 + payloadBits(tokens, FIXED_LIT_LEN, FIXED_DIST_LEN);
  if (fixedBits < best.bits) best = { kind: 'fixed', bits: fixedBits };
  const litFreq = new Float64Array(288);
  const distFreq = new Float64Array(32);
  for (let t = 0; t < tokens.lens.length; t++) {
    if (tokens.lens[t] === 0) litFreq[tokens.lits[t]]++;
    else {
      litFreq[257 + lenCodeIndex(tokens.lens[t])]++;
      distFreq[distCodeIndex(tokens.dists[t])]++;
    }
  }
  litFreq[256]++;
  const litLen = codeLengths(litFreq, 15);
  const distLen = codeLengths(distFreq, 15);
  const header = dynamicHeader(litLen, distLen);
  if (header !== null) {
    const dynBits = 3 + header.bits + payloadBits(tokens, litLen, distLen);
    if (dynBits < best.bits) best = { kind: 'dynamic', bits: dynBits, litLen, distLen, header };
  }
  return best;
}

// The third parse pass is priced with the exact code lengths the previous parse's
// frequencies imply, instead of smoothed log-probability costs.
function exactCostsOf(tokens, start, end) {
  const stats = statsFromTokens(tokens, start, end);
  const litLen = codeLengths(stats.litFreq, 15);
  const distLen = codeLengths(stats.distFreq, 15);
  const litCost = new Float64Array(286);
  for (let i = 0; i < litCost.length; i++) litCost[i] = litLen[i] > 0 ? litLen[i] : 16;
  const distCost = new Float64Array(30);
  for (let i = 0; i < distCost.length; i++) distCost[i] = distLen[i] > 0 ? distLen[i] : 16;
  return { litCost, distCost };
}

function writeStored(w, data, start, end, last) {
  let at = start;
  while (at < end) {
    const len = Math.min(65535, end - at);
    const isLast = last && at + len === end;
    w.bits(isLast ? 1 : 0, 1);
    w.bits(0, 2);
    w.align();
    w.bytes.push(len & 0xff, len >>> 8, ~len & 0xff, (~len >>> 8) & 0xff);
    for (let i = 0; i < len; i++) w.bytes.push(data[at + i]);
    at += len;
  }
}

// The entry's own deflater: a complete zlib stream of `data`. maxChain bounds the
// LZ77 candidate search; it is a work budget chosen by the caller from the data size.
// opts.full enables the full-search matcher; opts.passes sets the parse passes,
// with 3 enabling the exact-cost pass.
export function deflateCustom(data, maxChain, opts = {}) {
  const full = opts.full === true;
  const passes = opts.passes ?? 2;
  const matcher = createMatcher(data, maxChain, full);
  const greedy = greedyTokens(data, matcher);
  enrichMatcher(matcher, greedy);
  const w = new BitWriter();
  const n = data.length;
  if (n === 0) {
    w.bits(1, 1);
    w.bits(1, 2);
    const empty = { lits: new Uint16Array(0), lens: new Uint16Array(0), dists: new Uint16Array(0) };
    writeTokens(w, empty, FIXED_LIT_LEN, FIXED_DIST_LEN);
  }
  for (let start = 0; start < n; start += BLOCK) {
    const end = Math.min(n, start + BLOCK);
    const last = end === n;
    const tokens = tokenise(data, start, end, matcher, greedy, passes, passes >= 3 ? exactCostsOf : null);
    const plan = planBlock(data, start, end, tokens);
    if (plan.kind === 'stored') {
      writeStored(w, data, start, end, last);
    } else if (plan.kind === 'fixed') {
      w.bits(last ? 1 : 0, 1);
      w.bits(1, 2);
      writeTokens(w, tokens, FIXED_LIT_LEN, FIXED_DIST_LEN);
    } else {
      w.bits(last ? 1 : 0, 1);
      w.bits(2, 2);
      writeDynamicHeader(w, plan.header, plan.litLen, plan.distLen);
      writeTokens(w, tokens, plan.litLen, plan.distLen);
    }
  }
  const body = w.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}

// Node's zlib at level 9, default and Z_FILTERED strategies: the guaranteed floor.
export function deflateZlib(data, filteredStrategy) {
  const opts = filteredStrategy
    ? { level: 9, memLevel: 8, strategy: constants.Z_FILTERED }
    : { level: 9, memLevel: 8 };
  const z = deflateSync(data, opts);
  return new Uint8Array(z.buffer, z.byteOffset, z.length);
}
