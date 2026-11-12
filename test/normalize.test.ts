import { describe, expect, it } from 'vitest';
import { StitchError, detectProvider, normalize } from '../src/index.js';
import { groupTokens } from '../src/tokens.js';

const isInt = (n: number): boolean => Number.isInteger(n);

describe('normalize: OpenAI and Groq verbose_json', () => {
  const resp = {
    task: 'transcribe',
    language: 'english',
    duration: 3.2,
    text: 'Hello there, world.',
    words: [
      { word: 'Hello', start: 0.1234, end: 0.5678 },
      { word: 'there,', start: 0.6, end: 1.0004 },
      { word: 'world.', start: 1.05, end: 1.9996 },
    ],
    segments: [{ id: 0, seek: 0, start: 0.1234, end: 1.9996, text: ' Hello there, world.' }],
  };

  it('turns seconds into integer milliseconds', () => {
    const t = normalize(resp);
    expect(t.hasTimestamps).toBe(true);
    expect(t.words?.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
      ['Hello', 123, 568],
      ['there,', 600, 1000],
      ['world.', 1050, 2000],
    ]);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0]).toMatchObject({ text: 'Hello there, world.', startMs: 123, endMs: 2000 });
    for (const w of t.words ?? []) expect(isInt(w.startMs) && isInt(w.endMs)).toBe(true);
  });

  it('treats a Groq response the same way', () => {
    const groq = { ...resp, x_groq: { id: 'req_1' } };
    expect(normalize(groq, { provider: 'groq' })).toEqual(normalize(resp, { provider: 'openai' }));
    expect(detectProvider(groq)).toBe('openai');
  });

  it('spreads words over segments when the response has no word times', () => {
    const t = normalize({ text: 'a b c d', segments: [{ start: 1, end: 3, text: ' a b c d' }] });
    expect(t.words?.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
      ['a', 1000, 1500],
      ['b', 1500, 2000],
      ['c', 2000, 2500],
      ['d', 2500, 3000],
    ]);
    expect(t.words?.every((w) => w.estimated)).toBe(true);
  });

  it('accepts a silent chunk with empty lists', () => {
    const t = normalize({ text: '', words: [], segments: [] });
    expect(t.hasTimestamps).toBe(true);
    expect(t.words).toEqual([]);
  });

  it('clamps negative starts to zero and ends before starts', () => {
    const t = normalize({ words: [{ word: 'x', start: -0.3, end: -0.1 }] });
    expect(t.words?.[0]).toMatchObject({ startMs: 0, endMs: 0 });
  });
});

describe('normalize: whisper.cpp verbose_json', () => {
  const tok = (word: string, start: number, end: number, probability = 0.9) => ({ word, start, end, t_dtw: -1, probability });
  const resp = {
    task: 'transcribe',
    language: 'en',
    duration: 2,
    text: ' hello world.',
    segments: [
      {
        id: 0,
        start: 0,
        end: 1.2,
        text: ' hello world.',
        words: [tok('[_BEG_]', 0, 0, 1), tok(' hel', 0, 0.2), tok('lo', 0.2, 0.4, 0.5), tok(' world', 0.5, 1.1), tok('.', 1.1, 1.1)],
      },
    ],
  };

  it('joins sub-word tokens into words', () => {
    const t = normalize(resp);
    expect(t.words?.map((w) => [w.text, w.startMs, w.endMs])).toEqual([
      ['hello', 0, 400],
      ['world.', 500, 1100],
    ]);
    expect(t.words?.[0]?.probability).toBe(0.5);
    expect(detectProvider(resp)).toBe('whispercpp');
  });

  it('groupTokens skips special tokens and attaches punctuation', () => {
    const words = groupTokens([
      { word: '[_BEG_]', start: 0, end: 0 },
      { word: ' hel', start: 0, end: 0.1 },
      { word: 'lo', start: 0.1, end: 0.2 },
      { word: ',', start: 0.2, end: 0.2 },
      { word: ' <|endoftext|>', start: 0.3, end: 0.3 },
    ]);
    expect(words).toEqual([{ text: 'hello,', start: 0, end: 0.2 }]);
  });

  it('interpolates when a segment has no tokens', () => {
    const t = normalize({ segments: [{ id: 0, start: 0, end: 1, text: ' one two', words: undefined }, { id: 1, start: 1, end: 2, text: ' three', words: [tok(' three', 1, 2)] }] }, { provider: 'whispercpp' });
    expect(t.words?.map((w) => w.text)).toEqual(['one', 'two', 'three']);
  });
});

describe('normalize: text only', () => {
  it('accepts { text } and plain strings', () => {
    for (const input of [{ text: ' hello there ' }, ' hello there ', 'hello there']) {
      const t = normalize(input);
      expect(t).toEqual({ text: 'hello there', segments: [], hasTimestamps: false });
    }
  });

  it('accepts the text shape with any provider name', () => {
    expect(normalize({ text: 'hi' }, { provider: 'openai' }).hasTimestamps).toBe(false);
  });
});

describe('normalize: errors', () => {
  it.each([[null], [42], [[]], [{}], [{ foo: 'bar' }], [{ words: [{ word: 'x' }] }], [{ segments: [{ start: 0, end: 1 }] }]])('rejects %j as UNKNOWN_FORMAT', (input) => {
    expect(() => normalize(input)).toThrowError(StitchError);
    try {
      normalize(input);
    } catch (e) {
      expect((e as StitchError).code).toBe('UNKNOWN_FORMAT');
    }
  });

  it('rejects a bad provider name with BAD_INPUT and says what to use', () => {
    try {
      normalize({ text: 'x' }, { provider: 'nope' as never });
      expect.unreachable();
    } catch (e) {
      expect((e as StitchError).code).toBe('BAD_INPUT');
      expect((e as StitchError).message).toContain('whispercpp');
    }
  });

  it('rejects whisper.cpp without segments', () => {
    expect(() => normalize({ words: [{ word: 'x', start: 0, end: 1 }] }, { provider: 'whispercpp' })).toThrowError(StitchError);
    expect(() => normalize({ foo: 1 }, { provider: 'whispercpp' })).toThrowError(/unknown transcription response/);
  });
});
