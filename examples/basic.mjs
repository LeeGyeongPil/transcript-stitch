// Minimal use of transcript-stitch with the practice (mock) chunk responses.
// Run after `npm run build`:  node examples/basic.mjs
import { readFileSync } from 'node:fs';
import { stitch, toSrt } from '../dist/index.js';

const dir = new URL('../fixtures/probe28/openai/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8'));

// One entry per chunk: where it starts in the original audio, and the raw API response.
const chunks = manifest.chunks.map((c) => ({
  startMs: c.startMs,
  endMs: c.endMs,
  result: JSON.parse(readFileSync(new URL(c.file, dir), 'utf8')),
}));

const result = stitch(chunks);
process.stdout.write(toSrt(result));
