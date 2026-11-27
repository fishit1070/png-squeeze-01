// Filtered-data construction: turn a form's samples into the raw byte stream a PNG
// holds (one filter byte before each row) under several deterministic strategies.
// Strategies: a fixed filter type 0..4 for every row, 'minsum' (least signed byte sum),
// 'pairs' (fewest distinct neighbouring byte pairs) and 'entropy' (least order-0
// entropy of the row's own byte histogram). The pipeline screens them all with a real
// deflater and keeps the smallest result, so a strategy only has to be cheap and
// occasionally right.
import { deflateSync } from 'node:zlib';
import { filterRow, signedSum } from './png.mjs';

const LOG2 = Math.log(2);

// Order-0 entropy, in bits, of a byte row under its own histogram.
function entropyOf(row) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let bits = 0;
  const n = row.length;
  for (let v = 0; v < 256; v++) {
    const c = hist[v];
    if (c > 0) bits += c * Math.log2(n / c);
  }
  return bits / LOG2 * LOG2; // bits already: log2 used directly
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Build the filtered raw data of `samples` (height rows of width*bpp) under `choice`:
// a filter type 0..4, or 'minsum', 'pairs' or 'entropy' (per row, the lowest type on a
// tie). Writes into `raw` when given (it must be exactly height*(stride+1) bytes).
export function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  // Trial rows carry a leading filter byte (used by the brute strategy); the
  // heuristic strategies fill and read only the part after it.
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    if (choice === 'brute') {
      // Per-row choice by true deflate cost: each trial row, behind its filter
      // byte, is deflated at level 4 with the raw stream written so far (up to
      // 32 KiB) as its dictionary; the smallest wins, the lower type on a tie.
      // The most accurate row judge available, and the most expensive, so the
      // strategy is only offered for smaller raw data.
      const before = raw.subarray(Math.max(0, at - 32768), at);
      let type = 0;
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        trial[t][0] = t;
        filterRow(t, cur, prev, bpp, trial[t].subarray(1));
        const z = before.length === 0
          ? deflateSync(trial[t], { level: 4, memLevel: 9 })
          : deflateSync(trial[t], { level: 4, memLevel: 9, dictionary: before });
        if (z.length < best) {
          best = z.length;
          type = t;
        }
      }
      raw.set(trial[type], at);
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = entropyOf(trial[t].subarray(1));
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    raw.set(trial[type].subarray(1), at + 1);
  }
  return raw;
}

// The filter strategies screened for a form. Screening is one zlib level-6 run each,
// cheap enough to afford the full menu at every size (the screen's winner is not
// always the intuitive one: a flat None wins even on the big alpha captures, whose
// transparent regions are long zero runs). The expensive deflaters are reserved for
// the best-screened variants by the pipeline. All choices are fixed, never a
// function of any clock, so runs stay byte-identical.
export function strategiesFor(form, rawSize) {
  if (form.kind === 'palette') {
    if (form.order === 'count') return [0, 'minsum'];
    return [0, 'minsum', 'pairs', 'entropy'];
  }
  // Brute force earns its construction cost only on channel data of modest size
  // (it is the grey winner); on palette indices and on the big captures the
  // heuristics plus the real deflaters do as well for far less time.
  return rawSize <= 1200000
    ? [0, 1, 2, 4, 'minsum', 'pairs', 'entropy', 'brute']
    : [0, 1, 2, 4, 'minsum', 'pairs', 'entropy'];
}

// The filtered bytes of rows [y0, y1) under one fixed filter type, as a fresh
// Uint8Array of (y1 - y0) * (width * bpp + 1) bytes. The previous row of row
// y0 is samples row y0 - 1 (null when y0 is 0), exactly as in a whole-image
// filtering, so ranges tile a whole image's fixed-type stream seamlessly.
export function filteredRange(samples, width, bpp, type, y0, y1) {
  const stride = width * bpp;
  const out = new Uint8Array((y1 - y0) * (stride + 1));
  for (let y = y0; y < y1; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = (y - y0) * (stride + 1);
    out[at] = type;
    filterRow(type, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
  }
  return out;
}

// A filtered byte stream assembled segment by segment: for each segment of
// segmentRows rows (the last one shorter), the candidates are slices of the
// given whole-image variant streams (in the order given) followed by the
// fixed filter types 0, 1, 2 and 4 built for just that segment; judge(bytes)
// scores each candidate (smaller wins, the first candidate wins a tie) and
// the winning bytes are copied into the result. Judging with a real deflater
// prices a segment's filter choice by what it actually costs to compress,
// where the whole-image strategies must commit one choice for every row.
export function segmentedData(samples, width, height, bpp, variantDatas, segmentRows, judge) {
  const stride = width * bpp;
  const rowBytes = stride + 1;
  const out = new Uint8Array(height * rowBytes);
  for (let y0 = 0; y0 < height; y0 += segmentRows) {
    const y1 = Math.min(height, y0 + segmentRows);
    let best = null;
    let bestScore = Infinity;
    for (const data of variantDatas) {
      const seg = data.subarray(y0 * rowBytes, y1 * rowBytes);
      const score = judge(seg);
      if (score < bestScore) {
        bestScore = score;
        best = seg;
      }
    }
    for (const type of [0, 1, 2, 4]) {
      const seg = filteredRange(samples, width, bpp, type, y0, y1);
      const score = judge(seg);
      if (score < bestScore) {
        bestScore = score;
        best = seg;
      }
    }
    out.set(best, y0 * rowBytes);
  }
  return out;
}
