import { describe, expect, it } from 'vitest';
import { StitchError, detectSilences, readWavInfo, readWavSamples } from '../src/index.js';
import { makeWav, toneAndSilence } from './helpers.js';

const RATE = 16_000;
const FRAME_MS = 20;

describe('AC-6: detectSilences on synthetic PCM', () => {
  it('finds 0.8 s silences after 6.2 s tones within one frame', () => {
    const samples = toneAndSilence(RATE, 21_000, 6200, 800);
    const found = detectSilences(samples, RATE);
    // silences at 6200-7000, 13200-14000, 20200-21000
    expect(found).toHaveLength(3);
    [6200, 13_200, 20_200].forEach((startMs, i) => {
      expect(Math.abs(found[i]!.startMs - startMs)).toBeLessThanOrEqual(FRAME_MS);
      expect(Math.abs(found[i]!.endMs - (startMs + 800))).toBeLessThanOrEqual(FRAME_MS);
    });
  });

  it('works on Float32Array samples with the same result', () => {
    const ints = toneAndSilence(RATE, 14_000, 6200, 800);
    const floats = Float32Array.from(ints, (v) => v / 32768);
    expect(detectSilences(floats, RATE)).toEqual(detectSilences(ints, RATE));
  });

  it('ignores silences shorter than minSilenceMs and honours the options', () => {
    const samples = toneAndSilence(RATE, 14_000, 6200, 300);
    expect(detectSilences(samples, RATE)).toEqual([]);
    expect(detectSilences(samples, RATE, { minSilenceMs: 200 }).length).toBeGreaterThan(0);
  });

  it('treats quiet noise as silence below the threshold and speech-level noise as sound', () => {
    const quiet = new Int16Array(RATE * 2).map((_, i) => (i % 2 === 0 ? 20 : -20)); // about -64 dBFS
    expect(detectSilences(quiet, RATE)).toEqual([{ startMs: 0, endMs: 2000 }]);
    const loud = new Int16Array(RATE * 2).map((_, i) => (i % 2 === 0 ? 8000 : -8000));
    expect(detectSilences(loud, RATE)).toEqual([]);
    expect(detectSilences(quiet, RATE, { thresholdDb: -80 })).toEqual([]);
  });

  it('handles empty input and rejects bad arguments', () => {
    expect(detectSilences(new Int16Array(0), RATE)).toEqual([]);
    expect(() => detectSilences(new Int16Array(10), 0)).toThrowError(StitchError);
    expect(() => detectSilences(new Int16Array(10), RATE, { frameMs: 0 })).toThrowError(StitchError);
  });
});

describe('readWavInfo', () => {
  it('reads the header of a synthetic WAV file', () => {
    const wav = makeWav(toneAndSilence(RATE, 3000, 1000, 500), RATE);
    expect(readWavInfo(wav)).toEqual({ sampleRate: RATE, channels: 1, bitsPerSample: 16, dataOffset: 44, dataBytes: 96_000, durationMs: 3000 });
  });

  it('decodes samples and averages channels', () => {
    const stereo = makeWav(Int16Array.from([100, 300, 200, 400]), RATE, 2);
    const { info, samples } = readWavSamples(stereo);
    expect(info.channels).toBe(2);
    expect(Array.from(samples)).toEqual([200, 300]);
  });

  it('works on a view with an offset into a bigger buffer', () => {
    const wav = makeWav(toneAndSilence(RATE, 1000, 500, 500), RATE);
    const big = new Uint8Array(wav.length + 10);
    big.set(wav, 10);
    expect(readWavInfo(big.subarray(10)).durationMs).toBe(1000);
  });

  it('uses the available bytes when the data size is zero (streamed files)', () => {
    const wav = makeWav(new Int16Array(RATE), RATE);
    new DataView(wav.buffer).setUint32(40, 0, true);
    expect(readWavInfo(wav).durationMs).toBe(1000);
  });

  const reason = (bytes: Uint8Array): string => {
    try {
      readWavInfo(bytes);
    } catch (e) {
      expect((e as StitchError).code).toBe('BAD_WAV');
      return String((e as StitchError).details.reason);
    }
    return 'none';
  };

  it('rejects files that are not usable with a reason', () => {
    expect(reason(new Uint8Array(4))).toBe('too_short');
    expect(reason(new TextEncoder().encode('ID3 this is an mp3 not a wav'))).toBe('not_riff');
    const wav = makeWav(new Int16Array(100), RATE);
    expect(reason(wav.subarray(0, 36))).toBe('no_data');
    const float = makeWav(new Int16Array(100), RATE);
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(reason(float)).toBe('not_pcm');
  });

  it('refuses to analyse 24-bit audio and says how to convert', () => {
    const wav = makeWav(new Int16Array(100), RATE);
    new DataView(wav.buffer).setUint16(34, 24, true);
    try {
      readWavSamples(wav);
      expect.unreachable();
    } catch (e) {
      expect((e as StitchError).message).toContain('pcm_s16le');
    }
  });
});
