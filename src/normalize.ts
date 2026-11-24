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
    `unknown transcription response: ${detail}. Expected an OpenAI/Groq verbose_json, a whisper.cpp verbose_json, or text ({ text } or a string); for SRT/VTT pass provider "srt" or "vtt".`,
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

const CUE_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const CUE_EXAMPLE = '00:00:01,000 --> 00:00:02,000';

/** A cue-file parse error. `details.line` is the 1-based line, which lets the CLI show where the file is wrong. */
function cueError(line: number, detail: string): StitchError {
  return new StitchError(
    'UNKNOWN_FORMAT',
    `invalid SRT/VTT cue file at line ${line}: ${detail}. Cue time lines look like "${CUE_EXAMPLE}" (VTT also allows "00:01.000 --> 00:02.000").`,
    { line, detail },
  );
}

function cueTimeToMs(raw: string, label: string, line: number): number {
  const m = CUE_TIME.exec(raw.trim());
  if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) throw cueError(line, `${label} is not a valid cue time: "${raw.trim()}"`);
  return (Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number((m[4] as string).padEnd(3, '0'));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '', rlm: '' };

/** Decode the WebVTT character references that the spec defines. Unknown references stay as they are. */
function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_m, name: string) => ENTITIES[name] as string);
}

/** Parse SRT or WebVTT text into segments with interpolated (estimated) words. */
function parseCues(input: string, kind: 'srt' | 'vtt'): Transcript {
  const lines = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const segments: Segment[] = [];
  const words: Word[] = [];
  const isBlank = (n: number): boolean => (lines[n] ?? '').trim() === '';
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? '').trim();
    if (line === '') {
      i++;
      continue;
    }
    if (!line.includes('-->')) {
      if (/^WEBVTT(\s|$)/.test(line) || /^(NOTE|STYLE|REGION)(\s|$)/.test(line)) {
        // Skip the whole block: the WEBVTT header may carry metadata lines such as "Kind: captions".
        while (i < lines.length && !isBlank(i)) i++;
      } else if ((lines[i + 1] ?? '').includes('-->')) {
        i++; // cue number or identifier
      } else {
        throw cueError(i + 1, `unexpected line "${line.slice(0, 40)}" outside a cue`);
      }
      continue;
    }
    const startLine = i + 1;
    const [left = '', right = ''] = line.split('-->');
    const startMs = cueTimeToMs(left, 'cue start', startLine);
    const endMs = cueTimeToMs(right.trim().split(/\s+/)[0] ?? '', 'cue end', startLine);
    i++;
    const body: string[] = [];
    while (i < lines.length && !isBlank(i)) {
      const next = (lines[i] as string).trim();
      // A missing blank line: the next cue (time line, or number line followed by one) starts here.
      if (next.includes('-->') || (/^\d+$/.test(next) && (lines[i + 1] ?? '').includes('-->'))) break;
      body.push(next);
      i++;
    }
    let text = body.join(' ').replace(/<[^>]*>/g, '');
    if (kind === 'vtt') text = decodeEntities(text);
    text = text.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const [s, e] = clampRange(startMs, endMs);
    const segWords = interpolate(text, s, e);
    words.push(...segWords);
    segments.push({ text, startMs: s, endMs: e, chunk: 0, words: segWords });
  }
  return { text: segments.map((x) => x.text).join(' '), segments, words, hasTimestamps: true };
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
  if (!['auto', 'openai', 'groq', 'whispercpp', 'text', 'srt', 'vtt'].includes(requested)) {
    throw new StitchError('BAD_INPUT', `unknown provider "${String(requested)}"; use auto, openai, groq, whispercpp, text, srt or vtt`);
  }
  if (requested === 'srt' || requested === 'vtt') {
    if (typeof resp !== 'string') throw unknownFormat(`provider "${requested}" needs the cue file as a string`);
    return parseCues(resp, requested);
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
