import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChunkInput } from '../src/index.js';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

export function key(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

export interface Truth {
  text: string;
  words: { text: string; startMs: number; endMs: number }[];
}

export function loadTruth(name: string): Truth {
  return JSON.parse(readFileSync(join(FIXTURES, name, 'truth.json'), 'utf8')) as Truth;
}

/** Chunks of a fixture folder in the shape `stitch` takes. */
export function loadChunks(name: string, format: 'openai' | 'whispercpp' | 'text'): ChunkInput[] {
  const dir = join(FIXTURES, name, format);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    chunks: { file: string; startMs: number; endMs: number; overlapMs?: number }[];
  };
  return manifest.chunks.map((c) => {
    const input: ChunkInput = { startMs: c.startMs, endMs: c.endMs, result: JSON.parse(readFileSync(join(dir, c.file), 'utf8')) };
    if (c.overlapMs !== undefined) input.overlapMs = c.overlapMs;
    return input;
  });
}

/** Seeded random numbers (mulberry32) so random tests repeat exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 16-bit mono PCM WAV file in memory. */
export function makeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) v.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  writeAscii(36, 'data');
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

/** A sine tone for `toneMs` followed by silence for `silenceMs`, repeated until `totalMs`. */
export function toneAndSilence(sampleRate: number, totalMs: number, toneMs: number, silenceMs: number): Int16Array {
  const n = Math.round((sampleRate * totalMs) / 1000);
  const out = new Int16Array(n);
  const period = toneMs + silenceMs;
  for (let i = 0; i < n; i++) {
    const ms = (i * 1000) / sampleRate;
    if (ms % period < toneMs) out[i] = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }
  return out;
}
