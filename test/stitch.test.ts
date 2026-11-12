import { describe, expect, it } from 'vitest';
import { StitchError, naiveConcat, stitch, toSrt } from '../src/index.js';
import type { ChunkInput } from '../src/index.js';
import { key, loadChunks, loadTruth } from './helpers.js';

const keys = (words: { text: string }[] | undefined): string[] => (words ?? []).map((w) => key(w.text));

function maxDrift(words: { startMs: number }[], truth: { startMs: number }[]): number {
  return Math.max(...words.map((w, i) => Math.abs(w.startMs - (truth[i]?.startMs ?? Infinity))));
}

describe('AC-2: fixtures give exactly the truth', () => {
  const truth = loadTruth('probe28');

  it('naive concatenation keeps 37 words (9 duplicated), stitch gives the 28 truth words', () => {
    const chunks = loadChunks('probe28', 'openai');
    const naive = naiveConcat(chunks);
    expect(naive.words).toHaveLength(37);
    expect((naive.words?.length ?? 0) - truth.words.length).toBe(9);

    const s = stitch(chunks);
    expect(s.words).toHaveLength(28);
    expect(keys(s.words)).toEqual(truth.words.map((w) => key(w.text)));
    expect(maxDrift(s.words ?? [], truth.words)).toBeLessThanOrEqual(1);
  });

  it('keeps the whole word upload and drops the piece upl', () => {
    const chunks = loadChunks('probe28', 'openai');
    // the fixture really contains the piece
    expect(JSON.stringify(chunks[0]?.result)).toContain('"upl"');
    const texts = stitch(chunks).words?.map((w) => w.text) ?? [];
    expect(texts).toContain('upload');
    expect(texts).not.toContain('upl');
  });

  it('also matches for the whisper.cpp format (sub-word tokens)', () => {
    const s = stitch(loadChunks('probe28', 'whispercpp'));
    expect(keys(s.words)).toEqual(truth.words.map((w) => key(w.text)));
    expect(maxDrift(s.words ?? [], truth.words)).toBeLessThanOrEqual(1);
  });

  it('matches for the lecture fixture (overlaps 0, 1.5 s, 3 s and repeated phrases)', () => {
    const lecture = loadTruth('lecture');
    for (const format of ['openai', 'whispercpp'] as const) {
      const chunks = loadChunks('lecture', format);
      expect(new Set(chunks.map((c) => c.overlapMs))).toEqual(new Set([undefined, 0, 1500, 3000]));
      const s = stitch(chunks);
      expect(keys(s.words)).toEqual(lecture.words.map((w) => key(w.text)));
      expect(maxDrift(s.words ?? [], lecture.words)).toBeLessThanOrEqual(1);
      expect(s.report.warnings).toEqual([]);
    }
  });

  it('segments cover the words and times are integers and never go backwards', () => {
    const s = stitch(loadChunks('lecture', 'openai'));
    expect(s.segments.length).toBeGreaterThan(10);
    let last = 0;
    for (const w of s.words ?? []) {
      expect(Number.isInteger(w.startMs) && Number.isInteger(w.endMs)).toBe(true);
      expect(w.startMs).toBeGreaterThanOrEqual(last);
      last = w.startMs;
    }
    expect(s.segments.flatMap((seg) => seg.words ?? [])).toHaveLength(s.words?.length ?? -1);
    expect(s.text.split(' ')).toHaveLength(s.words?.length ?? -1);
  });
});

/** Words 400 ms apart, as chunk-relative seconds, for a chunk that starts at `startMs`. */
function chunkOf(words: string[], firstWordIndex: number, startMs: number, endMs: number, extra: Partial<ChunkInput> = {}): ChunkInput {
  return {
    startMs,
    endMs,
    ...extra,
    result: {
      words: words.map((w, i) => ({ word: w, start: ((firstWordIndex + i) * 400 - startMs) / 1000, end: ((firstWordIndex + i) * 400 + 350 - startMs) / 1000 })),
    },
  };
}

describe('AC-3: the real overlap comes from boundary times', () => {
  it('audio-chunker shaped input: reported 1500, actual 0, floating point times', () => {
    // words 0..4 in chunk A, 5..9 in chunk B; the chunks touch (no real overlap) but report 1500 ms
    const boundary = 2000.0000000000005;
    const a = chunkOf(['one', 'two', 'three', 'four', 'five'], 0, 0, boundary, { overlapMs: undefined });
    const b = chunkOf(['six', 'seven', 'eight', 'nine', 'ten'], 5, boundary, 4000, { overlapMs: 1500 });
    const s = stitch([a, b]);
    const bound = s.report.boundaries[0];
    expect(bound).toMatchObject({ actualOverlapMs: 0, reportedOverlapMs: 1500, method: 'adjacent', droppedLeft: 0, droppedRight: 0, matchedWords: 0 });
    expect(bound?.warnings.map((w) => w.code)).toEqual(['REPORTED_OVERLAP_DIFFERS']);
    expect(s.words).toHaveLength(10);
    expect(keys(s.words)).toEqual(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);
    for (const w of s.words ?? []) expect(Number.isInteger(w.startMs) && Number.isInteger(w.endMs)).toBe(true);
    expect(s.words?.[5]?.startMs).toBe(2000);
  });

  it('a real overlap with no matching words is cut at the midpoint and warns', () => {
    const a = chunkOf(['aa', 'bb', 'cc', 'dd', 'ee', 'ff'], 0, 0, 2400);
    const b = chunkOf(['xx', 'yy', 'zz', 'ww', 'vv'], 4, 1600, 4400);
    const s = stitch([a, b]);
    const bound = s.report.boundaries[0]!;
    expect(bound.actualOverlapMs).toBe(800);
    expect(bound.method).toBe('midpoint');
    expect(bound.warnings.map((w) => w.code)).toEqual(['NO_MATCH']);
    expect(s.report.warnings).toHaveLength(1);
    // midpoint of 1600..2400 is 2000: left words centred before it, right words centred after it
    expect(keys(s.words)).toEqual(['aa', 'bb', 'cc', 'dd', 'ee', 'yy', 'zz', 'ww', 'vv']);
    expect(bound).toMatchObject({ droppedLeft: 1, droppedRight: 1 });
    for (const w of s.words ?? []) expect(Number.isInteger(w.startMs)).toBe(true);
    const starts = (s.words ?? []).map((w) => w.startMs);
    expect([...starts].sort((x, y) => x - y)).toEqual(starts);
  });

  it('keep-both keeps every word when nothing matches', () => {
    const a = chunkOf(['aa', 'bb', 'cc', 'dd', 'ee', 'ff'], 0, 0, 2400);
    const b = chunkOf(['xx', 'yy', 'zz', 'ww', 'vv'], 4, 1600, 4400);
    expect(stitch([a, b], { onNoMatch: 'keep-both' }).words).toHaveLength(11);
  });

  it('is deterministic: the same input gives byte-identical output', () => {
    const run = (): string => JSON.stringify(stitch(loadChunks('lecture', 'openai')));
    expect(run()).toBe(run());
    const text = (): string => JSON.stringify(stitch(loadChunks('probe28', 'text')));
    expect(text()).toBe(text());
  });

  it('warns about a gap between chunks', () => {
    const a = chunkOf(['aa', 'bb'], 0, 0, 1000);
    const b = chunkOf(['cc', 'dd'], 4, 1600, 3000);
    const s = stitch([a, b]);
    expect(s.report.boundaries[0]).toMatchObject({ method: 'adjacent', actualOverlapMs: 0 });
    expect(s.report.warnings.map((w) => w.code)).toContain('GAP');
    expect(s.report.warnings.find((w) => w.code === 'GAP')?.data).toMatchObject({ gapMs: 600 });
  });

  it('uses the last word end when endMs is missing', () => {
    const a = chunkOf(['aa', 'bb', 'cc'], 0, 0, 0);
    delete (a as { endMs?: number }).endMs;
    const b = chunkOf(['bb', 'cc', 'dd'], 1, 400, 2000);
    const s = stitch([a, b]);
    expect(keys(s.words)).toEqual(['aa', 'bb', 'cc', 'dd']);
    expect(s.report.boundaries[0]?.actualOverlapMs).toBe(750);
  });

  it('does not duplicate repeated words that sit at the same times', () => {
    // "la la la" appears in both chunks at identical times; only the true alignment counts
    const a = chunkOf(['x', 'la', 'la', 'la'], 0, 0, 1600);
    const b = chunkOf(['la', 'la', 'la', 'y'], 1, 400, 2000);
    const s = stitch([a, b]);
    expect(keys(s.words)).toEqual(['x', 'la', 'la', 'la', 'y']);
  });
});

describe('AC-4: responses without timestamps', () => {
  it('English text: no duplicates, truth tokens, hasTimestamps false, no SRT', () => {
    const truth = loadTruth('probe28');
    const chunks = loadChunks('probe28', 'text');
    const s = stitch(chunks);
    expect(s.hasTimestamps).toBe(false);
    expect(s.words).toBeUndefined();
    expect(s.text.split(' ').map(key)).toEqual(truth.words.map((w) => key(w.text)));
    expect(s.text).toContain('upload');
    expect(s.text).not.toMatch(/\bupl\b/);
    expect(s.report.boundaries.map((b) => b.method)).toEqual(['text', 'text']);
    try {
      toSrt(s);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(StitchError);
      expect((e as StitchError).code).toBe('NO_TIMESTAMPS');
    }
  });

  it('Korean text: no duplicates, truth tokens', () => {
    const truth = loadTruth('ko-text');
    const s = stitch(loadChunks('ko-text', 'text'));
    expect(s.hasTimestamps).toBe(false);
    expect(s.text.split(' ').map(key)).toEqual(truth.words.map((w) => key(w.text)));
    expect(naiveConcat(loadChunks('ko-text', 'text')).text.split(' ').length).toBeGreaterThan(truth.words.length);
  });

  it('keeps both sides and warns when the text near the boundary does not match', () => {
    const s = stitch([
      { startMs: 0, endMs: 2000, result: { text: 'alpha beta gamma delta' } },
      { startMs: 1000, endMs: 3000, result: { text: 'one two three four' } },
    ]);
    expect(s.text).toBe('alpha beta gamma delta one two three four');
    expect(s.report.warnings.map((w) => w.code)).toEqual(['NO_MATCH']);
  });

  it('mixing timed and untimed chunks falls back to text and says so', () => {
    const timed = chunkOf(['aa', 'bb', 'cc'], 0, 0, 1200);
    const s = stitch([timed, { startMs: 1200, endMs: 2400, result: { text: 'dd ee' } }]);
    expect(s.hasTimestamps).toBe(false);
    expect(s.report.warnings.map((w) => w.code)).toContain('MIXED_TIMESTAMPS');
    expect(s.text).toBe('aa bb cc dd ee');
  });
});

describe('input checks', () => {
  const code = (fn: () => unknown): string => {
    try {
      fn();
    } catch (e) {
      return (e as StitchError).code;
    }
    return 'none';
  };

  it('rejects an empty list and bad chunks with BAD_INPUT', () => {
    expect(code(() => stitch([]))).toBe('BAD_INPUT');
    expect(code(() => stitch([{ startMs: Number.NaN, result: { text: 'x' } }]))).toBe('BAD_INPUT');
    expect(code(() => stitch([null as unknown as ChunkInput]))).toBe('BAD_INPUT');
    expect(code(() => stitch([{ startMs: 0, result: { text: 'x' } }], { minMatchWords: 0 }))).toBe('BAD_INPUT');
  });

  it('rejects chunks out of time order with NON_MONOTONIC', () => {
    const a = { startMs: 5000, result: { text: 'x y' } };
    const b = { startMs: 1000, result: { text: 'y z' } };
    try {
      stitch([a, b]);
      expect.unreachable();
    } catch (e) {
      expect((e as StitchError).code).toBe('NON_MONOTONIC');
      expect((e as StitchError).details).toEqual({ index: 1 });
    }
  });

  it('passes UNKNOWN_FORMAT through from normalize', () => {
    expect(code(() => stitch([{ startMs: 0, result: { nope: true } }]))).toBe('UNKNOWN_FORMAT');
  });

  it('a single chunk is returned as it is', () => {
    const s = stitch([loadChunks('probe28', 'openai')[0]!]);
    expect(s.report.boundaries).toEqual([]);
    expect(s.words).toHaveLength(7);
  });

  it('handles an empty chunk in the middle with a warning', () => {
    const a = chunkOf(['aa', 'bb'], 0, 0, 1000);
    const empty: ChunkInput = { startMs: 1000, endMs: 2000, result: { text: '', words: [] } };
    const c = chunkOf(['cc', 'dd'], 5, 2000, 3000);
    const s = stitch([a, empty, c]);
    expect(keys(s.words)).toEqual(['aa', 'bb', 'cc', 'dd']);
    expect(s.report.warnings.map((w) => w.code)).toContain('EMPTY_CHUNK');
  });
});
