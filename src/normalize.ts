import { StitchError } from './errors.js';
import { groupTokens, tokenize, type RawToken } from './tokens.js';
import { secToMs } from './time.js';
import type { Provider, Segment, Transcript, Word } from './types.js';

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownFormat(detail: string): StitchError {
  return new StitchError(
    'UNKNOWN_FORMAT',
    `unknown transcription response: ${detail}. Expected an OpenAI/Groq verbose_json, a whisper.cpp verbose_json, or text ({ text } or a string).`,
  );
}

function clampRange(startMs: number, endMs: number): [number, number] {
  const start = Math.max(0, startMs);
  return [start, Math.max(start, endMs)];
}

function makeWord(text: string, startMs: number, endMs: number, extra: { probability?: number; estimated?: boolean } = {}): Word {
  const [s, e] = clampRange(startMs, endMs);
  const w: Word = { text, startMs: s, endMs: e, chunk: 0 };
  if (extra.probability !== undefined) w.probability = extra.probability;
  if (extra.estimated) w.estimated = true;
  return w;
}

/** Spread the tokens of a segment evenly over its time range (used when no word times exist). */
function interpolate(text: string, startMs: number, endMs: number): Word[] {
  const tokens = tokenize(text);
  const [s, e] = clampRange(startMs, endMs);
  const span = e - s;
  return tokens.map((token, i) =>
    makeWord(token, s + Math.round((span * i) / tokens.length), s + Math.round((span * (i + 1)) / tokens.length), { estimated: true }),
  );
}

function readWordList(list: unknown[], label: string): Word[] {
  return list.map((raw, i) => {
    if (!isObj(raw) || typeof raw.word !== 'string') throw unknownFormat(`${label}[${i}] has no "word" string`);
    const text = raw.word.trim();
    const start = secToMs(raw.start, `${label}[${i}].start`);
    const end = secToMs(raw.end, `${label}[${i}].end`);
    const prob = typeof raw.probability === 'number' ? raw.probability : undefined;
    return makeWord(text, start, end, prob === undefined ? {} : { probability: prob });
  }).filter((w) => w.text !== '');
}

function readSegmentTimes(raw: unknown, i: number): { text: string; startMs: number; endMs: number; obj: Obj } {
  if (!isObj(raw) || typeof raw.text !== 'string') throw unknownFormat(`segments[${i}] has no "text" string`);
  const startMs = secToMs(raw.start, `segments[${i}].start`);
  const endMs = secToMs(raw.end, `segments[${i}].end`);
  const [s, e] = clampRange(startMs, endMs);
  return { text: raw.text.trim(), startMs: s, endMs: e, obj: raw };
}

function joinWords(words: Word[]): string {
  return words.map((w) => w.text).join(' ');
}

function textOnly(text: string): Transcript {
  return { text: text.trim(), segments: [], hasTimestamps: false };
}

/** Detect which response shape `resp` has. Throws `UNKNOWN_FORMAT` when none fits. */
export function detectProvider(resp: unknown): Exclude<Provider, 'auto'> {
  if (typeof resp === 'string') return 'text';
  if (!isObj(resp)) throw unknownFormat(`got ${resp === null ? 'null' : typeof resp}`);
  if (Array.isArray(resp.words)) return 'openai' as const;
  if (Array.isArray(resp.segments)) {
    const nested = resp.segments.some((s) => isObj(s) && Array.isArray(s.words));
    if (nested) return 'whispercpp';
    return 'openai';
  }
  if (typeof resp.text === 'string') return 'text';
  throw unknownFormat('no words, segments or text field');
}

/**
 * Convert one chunk response into the common format: integer milliseconds,
 * relative to the start of the chunk. Unknown fields are ignored.
 */
export function normalize(resp: unknown, opts: { provider?: Provider } = {}): Transcript {
  const requested = opts.provider ?? 'auto';
  if (!['auto', 'openai', 'groq', 'whispercpp', 'text'].includes(requested)) {
    throw new StitchError('BAD_INPUT', `unknown provider "${String(requested)}"; use auto, openai, groq, whispercpp or text`);
  }
  if (typeof resp === 'string') return textOnly(resp);
  const kind = requested === 'auto' ? detectProvider(resp) : requested;
  if (!isObj(resp)) throw unknownFormat(`got ${resp === null ? 'null' : typeof resp}`);

  if (kind === 'text' || (!Array.isArray(resp.words) && !Array.isArray(resp.segments))) {
    if (typeof resp.text !== 'string') throw unknownFormat('no "text" string');
    return textOnly(resp.text);
  }

  const topText = typeof resp.text === 'string' ? resp.text.trim() : undefined;

  if (kind === 'whispercpp') {
    if (!Array.isArray(resp.segments)) throw unknownFormat('whisper.cpp response has no "segments" array');
    const segments: Segment[] = [];
    const words: Word[] = [];
    resp.segments.forEach((raw, i) => {
      const seg = readSegmentTimes(raw, i);
      let segWords: Word[];
      if (Array.isArray(seg.obj.words)) {
        const tokens: RawToken[] = (seg.obj.words as unknown[]).map((t, k) => {
          if (!isObj(t) || typeof t.word !== 'string') throw unknownFormat(`segments[${i}].words[${k}] has no "word" string`);
          const token: RawToken = { word: t.word, start: Number(t.start), end: Number(t.end) };
          if (typeof t.probability === 'number') token.probability = t.probability;
          return token;
        });
        segWords = groupTokens(tokens).map((g) =>
          makeWord(g.text, secToMs(g.start, `segments[${i}].words.start`), secToMs(g.end, `segments[${i}].words.end`), g.probability === undefined ? {} : { probability: g.probability }),
        );
      } else {
        segWords = interpolate(seg.text, seg.startMs, seg.endMs);
      }
      words.push(...segWords);
      segments.push({ text: seg.text, startMs: seg.startMs, endMs: seg.endMs, chunk: 0, words: segWords });
    });
    return { text: topText ?? joinWords(words), segments, words, hasTimestamps: true };
  }

  // openai and groq share one shape
  const segments: Segment[] = [];
  const segmentWords: Word[] = [];
  if (Array.isArray(resp.segments)) {
    resp.segments.forEach((raw, i) => {
      const seg = readSegmentTimes(raw, i);
      segments.push({ text: seg.text, startMs: seg.startMs, endMs: seg.endMs, chunk: 0 });
      if (!Array.isArray(resp.words)) segmentWords.push(...interpolate(seg.text, seg.startMs, seg.endMs));
    });
  }
  const words = Array.isArray(resp.words) ? readWordList(resp.words, 'words') : segmentWords;
  const text = topText ?? (segments.length > 0 ? segments.map((s) => s.text).join(' ') : joinWords(words));
  return { text, segments, words, hasTimestamps: true };
}
