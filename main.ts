// Entry point: squeeze every instance of the set. Reads /input/<id>/image.png (or
// $MAKEFUN_INPUT_DIR), writes the smallest lossless PNG we can build to
// /output/<id>/image.png (or $MAKEFUN_OUTPUT_DIR), creating the directory. The work
// is a pure function of the input bytes: no clock, no environment, no randomness,
// so the grader's two executions produce byte-identical answers.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { squeezeImage } from './src/pipeline.mjs';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(inputDir).sort()) {
  const input = new Uint8Array(readFileSync(join(inputDir, id, 'image.png')));
  const answer = squeezeImage(input);
  mkdirSync(join(outputDir, id), { recursive: true });
  writeFileSync(join(outputDir, id, 'image.png'), answer);
}
