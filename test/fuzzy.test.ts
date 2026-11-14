import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StitchError, stitch } from '../src/index.js';
import type { ChunkInput } from '../src/index.js';
import { DEFAULT_FUZZY_THRESHOLD, fuzzyKeyMatch, jaroWinkler } from '../src/tokens.js';
import { key, loadChunks, loadTruth } from './helpers.js';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof StitchError ? e.code : 'OTHER';
  }
  return undefined;
};

const textChunks: ChunkInput[] = [
  { startMs: 0, endMs: 10000, result: 'we check the status every ten seconds today', provider: 'text' },
  { startMs: 8000, endMs: 20000, result: 'every 10 second today and log it', provider: 'text' },
];

function w(text: string, start: number): { word: string; start: number; end: number } {
  return { word: text, start, end: start + 0.4 };
}
const timedChunks: ChunkInput[] = [
  {
    startMs: 0,
    endMs: 10000,
    provider: 'openai',
    result: { text: '', words: [w('we', 0), w('check', 1), w('the', 2), w('status', 3), w('every', 8), w('ten', 8.5), w('seconds', 9), w('today', 9.5)] },
  },
  {
    startMs: 8000,
    endMs: 20000,
    provider: 'openai',
    result: { text: '', words: [w('every', 0), w('10', 0.5), w('second', 1), w('today', 1.5), w('and', 2.5), w('log', 3), w('it', 3.5)] },
  },
];

describe('fuzzy: similarity helper', () => {
  it('scores equal words 1 and unrelated words low', () => {
    expect(jaroWinkler('seconds', 'seconds')).toBe(1);
    expect(jaroWinkler('seconds', 'second')).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
    expect(jaroWinkler('cat', 'dog')).toBe(0);
    expect(jaroWinkler('', 'abc')).toBe(0);
  });
  it('never matches approximately when a key has fewer than 3 characters', () => {
    expect(fuzzyKeyMatch('10', 'ten', 0.1)).toBe(false);
    expect(fuzzyKeyMatch('a', 'ab', 0.1)).toBe(false);
    expect(fuzzyKeyMatch('color', 'colour', 0.85)).toBe(true);
  });
});

describe('fuzzy: text mode', () => {
  it('without the option keeps both sides with NO_MATCH (unchanged default)', () => {
    const s = stitch(textChunks);
    expect(s.report.warnings.map((x) => x.code)).toEqual(['NO_MATCH']);
    expect(s.text).toBe('we check the status every ten seconds today every 10 second today and log it');
    expect(JSON.stringify(stitch(textChunks, { fuzzy: false }))).toBe(JSON.stringify(s));
  });
  it('merges without duplicates and without NO_MATCH when fuzzy is on', () => {
    for (const fuzzy of [true, 0.85]) {
      const s = stitch(textChunks, { fuzzy });
      expect(s.report.warnings).toEqual([]);
      expect(s.text).toBe('we check the status every ten seconds today and log it');
    }
  });
  it('is deterministic', () => {
    expect(JSON.stringify(stitch(textChunks, { fuzzy: true }))).toBe(JSON.stringify(stitch(textChunks, { fuzzy: true })));
  });
});

describe('fuzzy: timestamp mode', () => {
  it('without the option falls back to the midpoint', () => {
    const s = stitch(timedChunks);
    expect(s.report.boundaries[0]?.method).toBe('midpoint');
    expect(s.report.warnings.map((x) => x.code)).toEqual(['NO_MATCH']);
  });
  it('aligns by words when fuzzy is on', () => {
    const s = stitch(timedChunks, { fuzzy: true });
    expect(s.report.boundaries[0]?.method).toBe('words');
    expect(s.report.boundaries[0]?.matchedWords).toBeGreaterThanOrEqual(2);
    expect(s.report.warnings).toEqual([]);
    expect((s.words ?? []).filter((x) => key(x.text) === 'today')).toHaveLength(1);
    expect(s.text.endsWith('today and log it')).toBe(true);
  });
});

describe('fuzzy: no regression on fixtures and repeated phrases', () => {
  it('gives the same result with fuzzy on for every fixture, twice', () => {
    for (const name of ['probe28', 'lecture'] as const) {
      const truth = loadTruth(name);
      for (const format of ['openai', 'whispercpp'] as const) {
        const chunks = loadChunks(name, format);
        const plain = stitch(chunks);
        const fuzzy = stitch(chunks, { fuzzy: true });
        expect(fuzzy.words?.map((x) => key(x.text))).toEqual(truth.words.map((x) => key(x.text)));
        expect(JSON.stringify(fuzzy.words)).toBe(JSON.stringify(plain.words));
        expect(JSON.stringify(stitch(chunks, { fuzzy: true }))).toBe(JSON.stringify(fuzzy));
      }
    }
    for (const name of ['probe28', 'ko-text'] as const) {
      const chunks = loadChunks(name, 'text');
      expect(stitch(chunks, { fuzzy: true }).text).toBe(stitch(chunks).text);
    }
  });
  it('keeps the exactly equal run for a repeated phrase', () => {
    const chunks: ChunkInput[] = [
      { startMs: 0, endMs: 10000, result: 'first we measure, we log the data', provider: 'text' },
      { startMs: 6000, endMs: 20000, result: 'we measure, we log the data then plot', provider: 'text' },
    ];
    expect(stitch(chunks, { fuzzy: true }).text).toBe(stitch(chunks).text);
  });
});

describe('fuzzy: option checks', () => {
  it('rejects out-of-range thresholds with BAD_INPUT', () => {
    for (const bad of [0, -0.5, 1.01, 2, Number.NaN, Infinity]) {
      expect(code(() => stitch(textChunks, { fuzzy: bad }))).toBe('BAD_INPUT');
    }
    expect(code(() => stitch(textChunks, { fuzzy: 1 }))).toBeUndefined();
    expect(code(() => stitch(textChunks, { fuzzy: 0.01 }))).toBeUndefined();
  });
  it('never matches 1-2 character keys approximately', () => {
    const chunks: ChunkInput[] = [
      { startMs: 0, endMs: 10000, result: 'alpha beta go to', provider: 'text' },
      { startMs: 8000, endMs: 20000, result: 'go do gamma', provider: 'text' },
    ];
    expect(stitch(chunks, { fuzzy: 0.1 }).report.warnings.map((x) => x.code)).toEqual(['NO_MATCH']);
  });
});

describe('fuzzy: CLI', () => {
  const run = (args: string[], lang = 'en'): { code: number | null; out: string; err: string } => {
    const r = spawnSync('node', [cli, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TRANSCRIPT_STITCH_LANG: lang } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  it('shows --fuzzy in both languages of stitch --help', () => {
    expect(run(['stitch', '--help'], 'en').out).toContain('--fuzzy');
    expect(run(['stitch', '--help'], 'ko').out).toContain('--fuzzy');
    expect(run(['stitch', '--help'], 'ko').out).toContain('기본값은 끔');
  });
  it('accepts --fuzzy and leaves the default output unchanged on fixtures', () => {
    const manifest = 'fixtures/lecture/openai/manifest.json';
    const base = run(['stitch', '--manifest', manifest, '--format', 'json']);
    const fuzzy = run(['stitch', '--manifest', manifest, '--format', 'json', '--fuzzy']);
    expect(base.code).toBe(0);
    expect(fuzzy.code).toBe(0);
    expect(fuzzy.out).toBe(base.out);
  });
});
