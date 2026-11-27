# PNG Squeeze — a lossless screenshot compressor

[![bounty](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/fishit1070/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/fishit1070/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

## How it works

For each of the 8 input screenshots (1280x720 RGBA) the program
(main.ts + src/*.mjs, pure Node 22, no dependencies) does:
1. Shape reduction per theme: palette encoding for flat images
(palette ordered by count/luminance/similarity), colour type 0
for grey images, tRNS where legal, and channel reduction.
2. Per-row filter strategies: fixed, minsum, pairs,
entropy-scored, and a brute mode that scores rows by true
deflate cost on small-channel data.
3. A custom optimal-parse deflater: lazy LZ77 matcher with
longest+nearest matches, two-pass dynamic-programming
optimal parsing, package-merge dynamic Huffman, and exact-
bit-cost block choice between stored/fixed/dynamic. It also
computes plain zlib-9 candidates and emits the smallest
bytes per instance, so no instance is ever worse than the
zlib-9 floor.
4. Verification: every winner is decoded back and compared
pixel by pixel before writing.
All search effort is budgeted by fixed work counts (chain
lengths, candidate counts, passes), never by the wall clock,
so two runs produce byte-identical output.

## Layout

- main.ts - orchestration, /input to /output
- src/png.mjs - PNG codec
- src/analyse.mjs - shape analysis
- src/filter.mjs - filter strategies
- src/lz77.mjs - matcher
- src/deflate.mjs - deflater
- src/pipeline.mjs - candidate pipeline

Entry for the make.fun bounty "Squeeze screenshots into the smallest PNG" (png-squeeze-01-run-20261127). MIT licensed (LICENSE file).
