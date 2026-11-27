// Image analysis and colour-form construction: decide which exact representations
// (palette / grey / grey+alpha / RGB / RGBA, with or without a tRNS key) can hold the
// image losslessly, and build each candidate form's sample bytes.

function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

// What the image holds: whether every pixel is opaque, whether every pixel is grey,
// and its colour list (with counts) when it has at most 256 distinct RGBA values.
export function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value (a grey level, or an RGB triple packed as r<<16|g<<8|b)
// that the image may key out with tRNS instead of an alpha channel: every pixel is either
// opaque or exactly that value at alpha 0, and no opaque pixel carries the same value.
// Null when there is no such value.
export function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// The image's samples in colour type ct (0, 2, 4 or 6) from its RGBA bytes.
export function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

const lumOf = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];

// Palette entries in the order a trial writes them: non-opaque entries first (by alpha,
// so a tRNS chunk stays short), then by the requested order among the opaque ones.
function paletteOrder(colours, order) {
  const entries = [...colours];
  if (order === 'similarity') {
    // Greedy nearest-neighbour walk in RGB space starting from the most frequent colour:
    // neighbouring indices land on similar colours, which keeps Sub/Paeth residuals small.
    const used = new Uint8Array(entries.length);
    const byCount = entries.map((c, i) => i).sort((a, b) => entries[b].count - entries[a].count || entries[a].word - entries[b].word);
    const seq = [];
    let cur = byCount[0];
    for (let k = 0; k < entries.length; k++) {
      seq.push(cur);
      used[cur] = 1;
      const [r, g, b] = entries[cur].rgba;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < entries.length; i++) {
        if (used[i]) continue;
        const dr = entries[i].rgba[0] - r;
        const dg = entries[i].rgba[1] - g;
        const db = entries[i].rgba[2] - b;
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD || (d === bestD && entries[i].word < entries[best].word)) {
          bestD = d;
          best = i;
        }
      }
      cur = best;
    }
    const rank = new Map(seq.map((ci, pos) => [ci, pos]));
    entries.sort((x, y) => {
      const ta = x.rgba[3] === 255 ? 1 : 0;
      const tb = y.rgba[3] === 255 ? 1 : 0;
      if (ta !== tb) return ta - tb;
      if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
      return rank.get(colours.indexOf(x)) - rank.get(colours.indexOf(y));
    });
    return entries;
  }
  entries.sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lumOf(x) - lumOf(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  return entries;
}

// One palette form: { plte, trns, indices } for the given entry order.
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// Every exact form worth trying for this image. Each form:
// { colourType, bpp, samples, plte, trns, kind } where kind is 'palette' or 'channels'
// and steers which filter strategies the pipeline screens for it.
export function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'similarity']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, kind: 'palette', order });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, kind: 'channels', order: null });
  return forms;
}

// Bytes the form's PLTE and tRNS chunks take in the file (12 bytes of framing each).
export function chunkBytes(form) {
  return (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
}
