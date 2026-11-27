// LZ77 stage of the entry's own deflater. A matcher answers, for any position, the
// longest match and the closest match (hash chains, a fixed candidate budget), and
// caches its answers: a lazy greedy parse goes first and decides which positions
// are worth asking about at all (its token starts, and one byte past each), then
// cost-optimal parses read the cache and ask for the few extra positions their own
// token starts need. Asking about every position instead would cost billions of
// byte comparisons on screen content, where hundreds of candidates match for
// hundreds of bytes. Every budget is a count of work, never a reading of any
// clock, so two runs over the same bytes always choose the same sequence.

export const MIN_MATCH = 3;
export const MAX_MATCH = 258;
const WINDOW = 32768;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;

// Length code buckets: for length L, the index into these tables gives the
// literal/length symbol (257 + index), its extra bits and the bucket's base length.
export const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
export const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
export const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
export const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

export function lenCodeIndex(len) {
  let lo = 0;
  let hi = LEN_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function distCodeIndex(dist) {
  let lo = 0;
  let hi = DIST_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function hash3(data, i) {
  return ((data[i] << 16 ^ data[i + 1] << 8 ^ data[i + 2]) * 0x9e3779b1 >>> 0) >>> (32 - HASH_BITS);
}

// A match oracle over `data`: hash chains over every position (built once), with
// per-position answers computed on demand and cached. query(i) fills matchLen /
// matchDist (the longest match, the closest distance on a tie) and altLen /
// altDist (the closest valid match, often a little shorter but far cheaper in
// distance bits; the parser prices both). With `full` set, query(i) walks the
// whole hash chain within the window (no candidate budget, no budget shrink
// after long matches) while keeping the one-byte pre-check that skips
// candidates which cannot beat the current best length.
export function createMatcher(data, maxChain, full = false) {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i + MIN_MATCH <= n; i++) {
    const h = hash3(data, i);
    prev[i] = head[h];
    head[h] = i;
  }
  const matchLen = new Uint16Array(n);
  const matchDist = new Uint16Array(n);
  const altLen = new Uint16Array(n);
  const altDist = new Uint16Array(n);
  const known = new Uint8Array(n);

  function query(i) {
    if (known[i]) return;
    known[i] = 1;
    if (i + MIN_MATCH > n) return;
    const maxLen = Math.min(MAX_MATCH, n - i);
    let bestLen = 0;
    let bestDist = 0;
    let closeLen = 0;
    let closeDist = 0;
    // Inherited candidate: the previous position's match, one byte shorter here,
    // when that position has been asked about.
    if (i > 0 && known[i - 1] && matchLen[i - 1] > MIN_MATCH) {
      const d = matchDist[i - 1];
      const j = i - d;
      if (j >= 0) {
        let l = matchLen[i - 1] - 1;
        while (l < maxLen && data[j + l] === data[i + l]) l++;
        if (l >= MIN_MATCH) {
          bestLen = l;
          bestDist = d;
        }
      }
    }
    let cand = prev[i];
    let tried = 0;
    let budget = full ? Infinity : maxChain;
    let bestFromChain = false;
    while (cand >= 0 && tried < budget) {
      const dist = i - cand;
      if (dist > WINDOW) break;
      tried++;
      // The first candidate is always measured in full, so the closest match is
      // known. A later candidate can only matter if it reaches past the current
      // best length (one byte check at bestLen) or ties the best length from a
      // smaller distance than the inherited match (one byte check at bestLen - 1).
      const mayTie = !bestFromChain && bestLen > 0;
      if (tried === 1 || bestLen === 0 || data[cand + bestLen] === data[i + bestLen] || (mayTie && data[cand + bestLen - 1] === data[i + bestLen - 1])) {
        let l = 0;
        while (l < maxLen && data[cand + l] === data[i + l]) l++;
        if (l >= MIN_MATCH) {
          if (closeLen === 0) {
            closeLen = l;
            closeDist = dist;
          }
          if (l > bestLen || (l === bestLen && dist < bestDist)) {
            bestLen = l;
            bestDist = dist;
            bestFromChain = true;
            if (!full) {
              if (bestLen >= 128) budget = Math.min(budget, tried + 4);
              else if (bestLen >= 64) budget = Math.min(budget, tried + 16);
            }
          }
        }
        // Once the best match reaches the length cap the walk can stop: the chain
        // is walked closest-first, so a later tie would only cost more distance.
        if (l >= maxLen || bestLen >= maxLen) break;
      }
      cand = prev[cand];
    }
    if (bestLen >= MIN_MATCH) {
      matchLen[i] = bestLen;
      matchDist[i] = bestDist;
    }
    if (closeLen >= MIN_MATCH) {
      altLen[i] = closeLen;
      altDist[i] = closeDist;
    }
  }

  return { data, matchLen, matchDist, altLen, altDist, known, query };
}

// A lazy greedy parse of the whole input: at each token start the matcher is asked
// about that position (and the next one, for the lazy step: a longer match starting
// one byte later wins a literal first). Returns the tokens and their start offsets.
export function greedyTokens(data, matcher) {
  const lits = [];
  const lens = [];
  const dists = [];
  const starts = [];
  const n = data.length;
  let i = 0;
  while (i < n) {
    matcher.query(i);
    const l = matcher.matchLen[i];
    if (l >= MIN_MATCH) {
      if (i + 1 < n) {
        matcher.query(i + 1);
        if (matcher.matchLen[i + 1] > l) {
          starts.push(i);
          lits.push(data[i]);
          lens.push(0);
          dists.push(0);
          i++;
          continue;
        }
      }
      starts.push(i);
      lits.push(0);
      lens.push(l);
      dists.push(matcher.matchDist[i]);
      i += l;
    } else {
      starts.push(i);
      lits.push(data[i]);
      lens.push(0);
      dists.push(0);
      i++;
    }
  }
  return { lits: Uint16Array.from(lits), lens: Uint16Array.from(lens), dists: Uint16Array.from(dists), starts: Int32Array.from(starts) };
}

// Widen the matcher's cache with what the greedy parse already knows: inside a
// greedy match of length L at distance d, the same match shortened is valid at
// every covered position, so those positions gain a match edge for free; and a
// stride of interior positions of long matches is asked properly, since a fresh
// match can start inside a long one wherever a new pattern begins.
export function enrichMatcher(matcher, greedy) {
  const { matchLen, matchDist, altLen, altDist, known, query } = matcher;
  for (let t = 0; t < greedy.lens.length; t++) {
    const L = greedy.lens[t];
    if (L < MIN_MATCH) continue;
    const s = greedy.starts[t];
    const d = greedy.dists[t];
    for (let off = 8; off < L; off += 16) query(s + off);
    for (let off = 1; off < L; off++) {
      const pos = s + off;
      if (known[pos]) continue;
      known[pos] = 1;
      matchLen[pos] = L - off;
      matchDist[pos] = d;
      altLen[pos] = L - off;
      altDist[pos] = d;
    }
  }
}

// Symbol statistics of the tokens that start inside [start, end).
export function statsFromTokens(tokens, start, end) {
  const litFreq = new Float64Array(286);
  const distFreq = new Float64Array(30);
  for (let t = 0; t < tokens.lens.length; t++) {
    const s = tokens.starts[t];
    if (s < start || s >= end) continue;
    if (tokens.lens[t] === 0) litFreq[tokens.lits[t]]++;
    else {
      litFreq[257 + lenCodeIndex(tokens.lens[t])]++;
      distFreq[distCodeIndex(tokens.dists[t])]++;
    }
  }
  litFreq[256] = 1; // the end-of-block symbol always occurs once
  return { litFreq, distFreq };
}

// Bit costs per symbol from frequencies, smoothed so unseen symbols stay possible.
function costsOf(freq, size) {
  let total = 0;
  for (let i = 0; i < size; i++) total += freq[i] + 1;
  const costs = new Float64Array(size);
  for (let i = 0; i < size; i++) costs[i] = Math.log2(total / (freq[i] + 1));
  return costs;
}

// The optimal tokenisation of data[start, end) under the given symbol costs, over
// the matches the matcher has cached (positions never asked about offer only the
// literal edge). Backward DP: cost[i] is the least cost of tokenising data[i, end);
// from each position the edges are the literal, and for each of the two cached
// matches (the longest, and the closest) its full length plus every length-code
// bucket top not above it (a shorter match in a cheaper length bucket, or at a
// cheaper distance, can win).
export function optimalParse(data, start, end, matcher, litCost, distCost) {
  const { matchLen, matchDist, altLen, altDist } = matcher;
  const m = end - start;
  const cost = new Float64Array(m + 1);
  const pickLen = new Uint16Array(m);
  const pickAlt = new Uint8Array(m);
  for (let i = m - 1; i >= 0; i--) {
    const pos = start + i;
    let best = litCost[data[pos]] + cost[i + 1];
    let bestL = 0;
    let bestAlt = 0;
    for (let which = 0; which < 2; which++) {
      const L = Math.min(which === 0 ? matchLen[pos] : altLen[pos], end - pos);
      if (L < MIN_MATCH) continue;
      const dc = distCost[distCodeIndex(which === 0 ? matchDist[pos] : altDist[pos])];
      const li = lenCodeIndex(L);
      const cFull = litCost[257 + li] + LEN_EXTRA[li] + dc + cost[i + L];
      if (cFull < best) {
        best = cFull;
        bestL = L;
        bestAlt = which;
      }
      for (let b = 0; b < li; b++) {
        const l = Math.min(LEN_BASE[b + 1] - 1, L);
        if (l < MIN_MATCH) continue;
        const c = litCost[257 + b] + LEN_EXTRA[b] + dc + cost[i + l];
        if (c < best) {
          best = c;
          bestL = l;
          bestAlt = which;
        }
      }
    }
    cost[i] = best;
    pickLen[i] = bestL;
    pickAlt[i] = bestAlt;
  }
  const lits = [];
  const lens = [];
  const dists = [];
  const starts = [];
  let i = 0;
  while (i < m) {
    const l = pickLen[i];
    starts.push(start + i);
    if (l === 0) {
      lits.push(data[start + i]);
      lens.push(0);
      dists.push(0);
      i++;
    } else {
      const pos = start + i;
      lits.push(0);
      lens.push(l);
      dists.push(pickAlt[i] === 1 ? altDist[pos] : matchDist[pos]);
      i += l;
    }
  }
  return { lits: Uint16Array.from(lits), lens: Uint16Array.from(lens), dists: Uint16Array.from(dists), starts: Int32Array.from(starts), bits: cost[0] };
}

// Tokenise data[start, end): statistics from the seed parse (the greedy parse of
// the whole input), then the optimal parse under them, twice over. Between the
// rounds the matcher is asked about the first parse's own token starts, and the
// second round's statistics come from that parse, which sharpens the costs where
// it matters. An optional third pass (passes >= 3) runs when `exactCosts` is
// given: the matcher is first asked about the second parse's token starts, then
// the parse is redone under the exact costs exactCosts(tokens, start, end)
// returns for that parse ({ litCost, distCost }, without extra bits folded in;
// the distance extra bits are folded in here, as in the other rounds). Without
// exactCosts the third pass simply reuses the statistics-based costs.
export function tokenise(data, start, end, matcher, seed, passes = 2, exactCosts = null) {
  let stats = statsFromTokens(seed, start, end);
  let tokens = null;
  for (let round = 0; round < passes; round++) {
    let litCost;
    // Distance cost as spent by the encoder: the code's bit length plus its extra bits.
    const distFull = new Float64Array(30);
    if (round === 2 && exactCosts !== null) {
      const exact = exactCosts(tokens, start, end);
      litCost = exact.litCost;
      for (let d = 0; d < 30; d++) distFull[d] = exact.distCost[d] + DIST_EXTRA[d];
    } else {
      litCost = costsOf(stats.litFreq, 286);
      const distCost = costsOf(stats.distFreq, 30);
      for (let d = 0; d < 30; d++) distFull[d] = distCost[d] + DIST_EXTRA[d];
    }
    tokens = optimalParse(data, start, end, matcher, litCost, distFull);
    if (round === 0) {
      for (let t = 0; t < tokens.starts.length; t++) matcher.query(tokens.starts[t]);
      stats = statsFromTokens(tokens, start, end);
    } else if (round === 1 && round < passes - 1) {
      // Widen the cache with the second parse's token starts before the third
      // pass; `stats` is left as it is, since that pass ignores it.
      for (let t = 0; t < tokens.starts.length; t++) matcher.query(tokens.starts[t]);
    }
  }
  return tokens;
}
