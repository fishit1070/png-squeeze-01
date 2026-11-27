// Per-image pipeline: decode the stored input, build every exact colour form, screen
// each form's filter strategies with zlib at level 6, then spend the real deflaters
// (Node zlib-9 in both strategies, and the entry's own optimal-parse deflater) on the
// two best-screened variants of each form and keep the smallest complete PNG. Every candidate is
// verified by decoding it back and comparing pixels before it may win, and the stored
// input itself is the final fallback, so an answer always exists. All budgets are
// functions of byte counts only: no clock is ever read, and two runs are identical.
import { deflateSync } from 'node:zlib';
import { decodePng, ihdrOf, pngOf } from './png.mjs';
import { formsOf, chunkBytes } from './analyse.mjs';
import { filtered, strategiesFor } from './filter.mjs';
import { deflateCustom, deflateZlib } from './deflate.mjs';

const SCREEN_OPTS = { level: 6, memLevel: 8 };

// Assemble the PNG of a form whose IDAT holds the zlib stream `idat`.
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

function samePixels(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Chain budget for the custom deflater, from the raw size alone. Small data
// earns a deep chain: on flat and grey screenshots the longest match often
// sits thousands of candidates into a hash chain, and 16384 candidates with
// the one-byte pre-check costs about a second where an unbounded walk
// costs tens of seconds. For large data, 512 candidates with three passes
// is the measured sweet spot for the large rich/alpha data: thousands of
// bytes better than 32-48 for a fraction of a second per run. Doubling the
// earlier budgets (8192/256) was measured to still pay for itself in bytes.
function chainFor(rawSize) {
  if (rawSize <= 1000000) return 16384;
  return 512;
}

// Options for the custom deflater, from the raw size alone: the third
// (exact-cost) parse pass is spent at every size: on the large instances
// it is worth thousands of bytes for a fraction of a second per run, and
// on small data it pairs with the deep chain.
function customOptsFor(rawSize) {
  return { passes: 3 };
}

// How many screened variants earn a full custom-deflate run. One per image:
// on small data the deep run goes to the best-screened variant; on large
// data a single run is all the budget allows, and the loop below spends it
// only where the custom deflater has measured wins (adaptive variants).
function customRunsFor(rawSize) {
  return 1;
}

// Compress one image (its stored PNG bytes) into the smallest verified PNG we can.
export function squeezeImage(inputBytes) {
  const dec = decodePng(inputBytes);
  if (!dec.ok) throw new Error('input does not decode: ' + dec.why);
  const { width, height, rgba } = dec;

  const candidates = [];
  const consider = (png) => {
    candidates.push(png);
  };

  const forms = formsOf(rgba).map((form) => {
    const rawSize = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    const screened = [];
    for (const choice of strategiesFor(form, rawSize)) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, SCREEN_OPTS);
      screened.push({ data, choice, screenBytes: z.length + chunks });
    }
    screened.sort((a, b) => a.screenBytes - b.screenBytes);
    return { form, rawSize, screened };
  });
  // The custom deflater is the expensive candidate, so it is spent only on the
  // leading form (the one whose best screened variant is smallest). Rival forms
  // still compete through their zlib-9 candidates.
  let leading = forms[0];
  for (const f of forms) if (f.screened[0].screenBytes < leading.screened[0].screenBytes) leading = f;
  for (const { form, rawSize, screened } of forms) {
    // A non-leading form more than 3% behind at screening cannot win: zlib-9
    // closes only about 1% on the same data, and the custom deflater is spent
    // on the leading form alone. Skipping its candidates buys the time the
    // deeper search spends.
    if (form !== leading.form && screened[0].screenBytes > leading.screened[0].screenBytes * 1.03) continue;
    const runs = form === leading.form ? Math.min(customRunsFor(rawSize), screened.length) : 0;
    const full = Math.min(rawSize <= 1100000 ? 3 : 2, screened.length);
    let customLeft = runs;
    // A second custom run on small data, only for an adaptive runner-up that
    // screened within 1% of the leader: i008's 'brute' variant is the measured
    // case, beating the fixed-filter leader under the custom deflater while
    // trailing it by 0.3% at screening. Wider gaps have never paid.
    if (rawSize <= 1100000 && customLeft > 0 && screened.length > 1
      && typeof screened[1].choice === 'string'
      && screened[1].screenBytes <= screened[0].screenBytes * 1.01) {
      customLeft = 2;
    }
    for (let s = 0; s < full; s++) {
      const { data, choice } = screened[s];
      consider(pngOfForm(width, height, form, deflateZlib(data, false)));
      consider(pngOfForm(width, height, form, deflateZlib(data, true)));
      // On large data the custom deflater's measured wins are all on per-row
      // adaptive variants ('pairs' above all); on fixed-filter variants it
      // loses to zlib-9 outright, so the one custom run is saved for the
      // first adaptive variant. On small data the run goes to the
      // best-screened variant as before.
      const eligible = rawSize <= 1100000 || typeof choice === 'string';
      if (customLeft > 0 && eligible) {
        consider(pngOfForm(width, height, form, deflateCustom(data, chainFor(rawSize), customOptsFor(rawSize))));
        customLeft--;
      }
    }
  }

  // Verify lazily, smallest first: a candidate may win only after it decodes back
  // to the exact pixels, and nearly every candidate is valid, so checking in size
  // order almost always costs a single decode instead of one per candidate.
  candidates.sort((a, b) => a.length - b.length);
  for (const png of candidates) {
    const back = decodePng(png, { width, height });
    if (!back.ok) continue;
    if (!samePixels(back.rgba, rgba)) continue;
    return png;
  }
  return new Uint8Array(inputBytes); // unreachable in practice
}
