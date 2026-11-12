import { describe, expect, it } from 'vitest';
import { StitchError, parseDuration, parseSize, planChunks } from '../src/index.js';
import type { PlanOptions, TimeRange } from '../src/index.js';
import { seeded } from './helpers.js';

function randomSilences(rand: () => number, durationMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  let t = 2000 + rand() * 8000;
  while (t < durationMs) {
    const len = 400 + rand() * 1500;
    out.push({ startMs: Math.round(t), endMs: Math.round(t + len) });
    t += len + 3000 + rand() * 20_000;
  }
  return out;
}

describe('AC-6: planChunks keeps its guarantees (200 seeded random cases)', () => {
  const rand = seeded(20261113);
  for (let n = 0; n < 200; n++) {
    const durationMs = Math.round(30_000 + rand() * 3_600_000);
    const bytesPerSecond = [16_000, 32_000, 48_000, 88_200, 176_400][Math.floor(rand() * 5)]!;
    const overlapMs = Math.round(rand() * 3000);
    const minChunkMs = Math.round(5000 + rand() * 10_000);
    const hasLimit = rand() < 0.5;
    const maxBytes = Math.round(2_000_000 + rand() * 25_000_000);
    const silences = rand() < 0.7 ? randomSilences(rand, durationMs) : [];
    const opts: PlanOptions = {
      durationMs,
      bytesPerSecond,
      maxBytes,
      overlapMs,
      minChunkMs,
      silences,
      ...(hasLimit ? { maxDurationMs: Math.round(60_000 + rand() * 1_200_000) } : {}),
    };

    it(`case ${n}`, () => {
      let plan;
      try {
        plan = planChunks(opts);
      } catch (e) {
        // only impossible combinations may fail
        expect((e as StitchError).code).toBe('PLAN_IMPOSSIBLE');
        const cap = Math.floor(maxBytes * 0.98) - 44;
        const maxMs = Math.min(Math.floor((cap * 1000) / bytesPerSecond), opts.maxDurationMs ?? Infinity);
        expect(maxMs <= overlapMs || maxMs < minChunkMs).toBe(true);
        return;
      }
      const limit = maxBytes * 0.98;
      expect(plan[0]!.startMs).toBe(0);
      expect(plan[plan.length - 1]!.endMs).toBe(durationMs);
      plan.forEach((c, i) => {
        expect(c.index).toBe(i);
        expect(c.estBytes).toBeLessThanOrEqual(limit);
        expect(c.endMs - c.startMs).toBeLessThanOrEqual(opts.maxDurationMs ?? Infinity);
        expect(c.endMs).toBeGreaterThan(c.startMs);
        if (i < plan.length - 1) {
          expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(minChunkMs);
          // cut inside a silence, or marked as forced
          const inSilence = silences.some((s) => c.endMs >= s.startMs && c.endMs <= s.endMs);
          expect(c.cutInSilence).toBe(inSilence);
          expect(c.cutInSilence !== c.forceSplit).toBe(true);
          // no gap: the next chunk starts overlapMs before this one ends
          expect(plan[i + 1]!.startMs).toBe(Math.max(0, c.endMs - overlapMs));
        } else {
          expect(c.forceSplit).toBe(false);
        }
      });
    });
  }
});

describe('planChunks details', () => {
  const base = { bytesPerSecond: 32_000, maxBytes: '25mb' } as const;

  it('needs a single chunk when everything fits', () => {
    const plan = planChunks({ ...base, durationMs: 60_000 });
    expect(plan).toEqual([{ index: 0, startMs: 0, endMs: 60_000, estBytes: 44 + 1_920_000, cutInSilence: false, forceSplit: false }]);
  });

  it('cuts in the middle of a silence that is inside the allowed range', () => {
    const plan = planChunks({ ...base, durationMs: 1_500_000, silences: [{ startMs: 700_000, endMs: 701_000 }] });
    expect(plan[0]).toMatchObject({ endMs: 700_500, cutInSilence: true, forceSplit: false });
  });

  it('forces the cut at the limit and marks it when there is no silence', () => {
    const plan = planChunks({ ...base, durationMs: 1_500_000 });
    // (25e6 * 0.98 - 44) bytes at 32000 bytes/s
    expect(plan[0]).toMatchObject({ endMs: 765_623, cutInSilence: false, forceSplit: true });
  });

  it('prefers the latest silence', () => {
    const plan = planChunks({
      ...base,
      durationMs: 1_500_000,
      silences: [
        { startMs: 100_000, endMs: 101_000 },
        { startMs: 700_000, endMs: 701_000 },
      ],
    });
    expect(plan[0]!.endMs).toBe(700_500);
  });

  it('accepts decimal and binary size strings', () => {
    expect(parseSize('25mb')).toBe(25_000_000);
    expect(parseSize('24MiB')).toBe(24 * 1024 * 1024);
    expect(parseSize('512kb')).toBe(512_000);
    expect(parseSize(1000)).toBe(1000);
    expect(() => parseSize('big')).toThrowError(StitchError);
    expect(() => parseSize('-3mb')).toThrowError(/cannot read size/);
    expect(parseDuration('1.5s')).toBe(1500);
    expect(parseDuration('20m')).toBe(1_200_000);
    expect(parseDuration('90ms')).toBe(90);
    expect(parseDuration('1h')).toBe(3_600_000);
    expect(() => parseDuration('soon')).toThrowError(StitchError);
  });

  it('throws PLAN_IMPOSSIBLE when the limit is smaller than the overlap', () => {
    for (const opts of [
      { ...base, durationMs: 600_000, maxDurationMs: 2000, overlapMs: 3000 },
      { ...base, durationMs: 600_000, maxBytes: 64_000, overlapMs: 2500 },
      { ...base, durationMs: 600_000, maxBytes: 40 },
      { ...base, durationMs: 600_000, maxDurationMs: 5000, minChunkMs: 10_000 },
    ]) {
      try {
        planChunks(opts);
        expect.unreachable();
      } catch (e) {
        expect((e as StitchError).code).toBe('PLAN_IMPOSSIBLE');
        expect((e as StitchError).message.length).toBeGreaterThan(20);
      }
    }
  });

  it('rejects invalid numbers with BAD_INPUT', () => {
    for (const opts of [
      { ...base, durationMs: 0 },
      { ...base, durationMs: 1000, bytesPerSecond: -1 },
      { ...base, durationMs: 1000, safetyRatio: 2 },
      { ...base, durationMs: 1000, maxBytes: 'lots' },
      { ...base, durationMs: 1000, overlapMs: -5 },
    ]) {
      try {
        planChunks(opts as PlanOptions);
        expect.unreachable();
      } catch (e) {
        expect((e as StitchError).code).toBe('BAD_INPUT');
      }
    }
  });
});
