import subsrt from 'subsrt-ts';
import { describe, expect, it } from 'vitest';
import { StitchError, stitch, toSrt, toText, toVtt } from '../src/index.js';
import type { Transcript } from '../src/index.js';
import { loadChunks } from './helpers.js';

const lecture = stitch(loadChunks('lecture', 'openai'));

interface ParsedCue {
  number: number;
  start: number;
  end: number;
  text: string;
}

/** Read our own SRT text line by line (independent of any library). */
function readCues(srt: string): ParsedCue[] {
  return srt
    .trim()
    .split(/\n\n/)
    .map((block) => {
      const [n, times, ...text] = block.split('\n');
      const m = /^(\d+):(\d+):(\d+)[,.](\d+) --> (\d+):(\d+):(\d+)[,.](\d+)$/.exec(times ?? '');
      if (!m) throw new Error('bad cue: ' + block);
      const ms = (h: string, mi: string, s: string, f: string): number => ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(f);
      return { number: Number(n), start: ms(m[1]!, m[2]!, m[3]!, m[4]!), end: ms(m[5]!, m[6]!, m[7]!, m[8]!), text: text.join('\n') };
    });
}

describe('AC-5: SRT and VTT rules', () => {
  const opts = { maxChars: 32, maxCueMs: 4000 };
  for (const [name, make, sep] of [
    ['srt', (t: Transcript) => toSrt(t, opts), ','],
    ['vtt', (t: Transcript) => toVtt(t, opts), '.'],
  ] as const) {
    it(`${name}: numbers 1.., monotonic, no overlap, line and cue limits`, () => {
      const out = make(lecture);
      if (name === 'vtt') expect(out.split('\n')[0]).toBe('WEBVTT');
      const cues = readCues(name === 'vtt' ? out.replace(/^WEBVTT\n\n/, '') : out);
      expect(cues.length).toBeGreaterThan(20);
      cues.forEach((c, i) => {
        expect(c.number).toBe(i + 1);
        expect(c.end).toBeGreaterThan(c.start);
        expect(c.end - c.start).toBeLessThanOrEqual(opts.maxCueMs);
        for (const line of c.text.split('\n')) expect(Array.from(line).length).toBeLessThanOrEqual(opts.maxChars);
        if (i > 0) {
          expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
          expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.start);
        }
      });
      expect(out).toContain(sep === ',' ? '00:00:00,000 -->' : '00:00:00.000 -->');
    });
  }

  it('subsrt-ts parses our SRT into the cues we generated', () => {
    const srt = toSrt(lecture);
    const ours = readCues(srt);
    const theirs = subsrt.parse(srt, { format: 'srt' }) as { start: number; end: number; content?: string; text?: string }[];
    expect(theirs).toHaveLength(ours.length);
    theirs.forEach((c, i) => {
      expect(c.start).toBe(ours[i]!.start);
      expect(c.end).toBe(ours[i]!.end);
      expect((c.text ?? c.content ?? '').replace(/\s+/g, ' ').trim()).toBe(ours[i]!.text);
    });
  });

  it('subsrt-ts converts our SRT to VTT with the same cue count', () => {
    const vtt = subsrt.convert(toSrt(lecture), { from: 'srt', to: 'vtt' });
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    const captions = (subsrt.parse(vtt, { format: 'vtt' }) as { type?: string }[]).filter((c) => c.type === undefined || c.type === 'caption');
    expect(captions).toHaveLength(readCues(toSrt(lecture)).length);
  });

  it('every word appears once and in order', () => {
    const joined = readCues(toSrt(lecture))
      .map((c) => c.text)
      .join(' ');
    expect(joined).toBe(lecture.text);
  });

  it('splits at sentence ends', () => {
    const cues = readCues(toSrt(lecture));
    expect(cues[0]!.text).toBe('Welcome back to the workshop.');
  });

  it('splits a word longer than maxChars instead of breaking the limit', () => {
    const t: Transcript = {
      text: 'supercalifragilistic',
      hasTimestamps: true,
      segments: [],
      words: [{ text: 'supercalifragilistic', startMs: 0, endMs: 2000, chunk: 0 }],
    };
    const cues = readCues(toSrt(t, { maxChars: 8 }));
    expect(cues.map((c) => c.text)).toEqual(['supercal', 'ifragili', 'stic']);
    expect(cues.every((c, i) => i === 0 || c.start >= cues[i - 1]!.end)).toBe(true);
  });

  it('keeps cues non-overlapping when words overlap in time', () => {
    const t: Transcript = {
      text: 'a b c',
      hasTimestamps: true,
      segments: [],
      words: [
        { text: 'a.', startMs: 0, endMs: 1000, chunk: 0 },
        { text: 'b.', startMs: 500, endMs: 900, chunk: 0 },
        { text: 'c.', startMs: 500, endMs: 500, chunk: 0 },
      ],
    };
    const cues = readCues(toSrt(t));
    expect(cues).toHaveLength(3);
    cues.forEach((c, i) => {
      expect(c.end).toBeGreaterThan(c.start);
      if (i > 0) expect(c.start).toBeGreaterThanOrEqual(cues[i - 1]!.end);
    });
  });

  it('works for a transcript with segments but no words', () => {
    const t: Transcript = { text: 'one two three four', hasTimestamps: true, words: undefined as never, segments: [{ text: 'one two three four', startMs: 0, endMs: 2000, chunk: 0 }] };
    expect(readCues(toSrt(t))[0]!.text).toBe('one two three four');
  });

  it('throws NO_TIMESTAMPS for text-only transcripts and BAD_INPUT for bad options', () => {
    const textOnly: Transcript = { text: 'hi there', segments: [], hasTimestamps: false };
    for (const fn of [toSrt, toVtt]) {
      try {
        fn(textOnly);
        expect.unreachable();
      } catch (e) {
        expect((e as StitchError).code).toBe('NO_TIMESTAMPS');
      }
    }
    try {
      toSrt(lecture, { maxChars: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as StitchError).code).toBe('BAD_INPUT');
    }
  });
});

describe('toText', () => {
  it('breaks paragraphs at long pauses', () => {
    const t: Transcript = {
      text: 'a b',
      hasTimestamps: true,
      words: [],
      segments: [
        { text: 'First.', startMs: 0, endMs: 1000, chunk: 0 },
        { text: 'Second.', startMs: 1500, endMs: 2000, chunk: 0 },
        { text: 'Third.', startMs: 6000, endMs: 7000, chunk: 0 },
      ],
    };
    expect(toText(t)).toBe('First. Second.\n\nThird.');
    expect(toText(t, { paragraphGapMs: 100 })).toBe('First.\n\nSecond.\n\nThird.');
  });

  it('returns the text for transcripts without timestamps', () => {
    expect(toText({ text: 'plain words', segments: [], hasTimestamps: false })).toBe('plain words');
  });
});
