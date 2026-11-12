import { StitchError } from './errors.js';
import { formatTimestamp } from './time.js';
import { tokenize } from './tokens.js';
import type { SubtitleOptions, TextOptions, Transcript, Word } from './types.js';

interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const SENTENCE_END = /[.!?…。！？]["')\]]*$/u;
const PAUSE_MS = 1000;

function wordsOf(t: Transcript): Word[] {
  if (!t.hasTimestamps) {
    throw new StitchError('NO_TIMESTAMPS', 'this transcript has no timestamps (text-only responses), so subtitles cannot be made; use toText instead');
  }
  if (t.words) return t.words;
  // A transcript built by hand with segments only: spread the words over each segment.
  return t.segments.flatMap((seg) => {
    const tokens = tokenize(seg.text);
    const span = seg.endMs - seg.startMs;
    return tokens.map((text, i) => ({
      text,
      chunk: seg.chunk,
      startMs: seg.startMs + Math.round((span * i) / tokens.length),
      endMs: seg.startMs + Math.round((span * (i + 1)) / tokens.length),
      estimated: true,
    }));
  });
}

function splitLongWord(w: Word, maxChars: number): Word[] {
  const chars = Array.from(w.text);
  if (chars.length <= maxChars) return [w];
  const pieces: Word[] = [];
  const n = Math.ceil(chars.length / maxChars);
  const span = w.endMs - w.startMs;
  for (let k = 0; k < n; k++) {
    pieces.push({
      ...w,
      text: chars.slice(k * maxChars, (k + 1) * maxChars).join(''),
      startMs: w.startMs + Math.round((span * k) / n),
      endMs: w.startMs + Math.round((span * (k + 1)) / n),
    });
  }
  return pieces;
}

function buildCues(t: Transcript, opts: SubtitleOptions): Cue[] {
  const maxChars = opts.maxChars ?? 42;
  const maxCueMs = opts.maxCueMs ?? 7000;
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new StitchError('BAD_INPUT', 'maxChars must be an integer >= 1');
  if (!Number.isInteger(maxCueMs) || maxCueMs < 1) throw new StitchError('BAD_INPUT', 'maxCueMs must be an integer >= 1');
  const words = wordsOf(t).flatMap((w) => splitLongWord(w, maxChars));
  const cues: Cue[] = [];
  let group: Word[] = [];
  let length = 0;

  const flush = (): void => {
    if (group.length === 0) return;
    const prevEnd = cues.length > 0 ? cues[cues.length - 1]!.endMs : 0;
    const startMs = Math.max(group[0]!.startMs, prevEnd);
    const lastEnd = group[group.length - 1]!.endMs;
    // Keep every cue at least 1 ms long and never longer than maxCueMs.
    const endMs = Math.min(Math.max(lastEnd, startMs + 1), startMs + maxCueMs);
    cues.push({ startMs, endMs, text: group.map((w) => w.text).join(' ') });
    group = [];
    length = 0;
  };

  words.forEach((w, i) => {
    const wordLen = Array.from(w.text).length;
    if (group.length > 0) {
      const first = group[0]!;
      if (length + 1 + wordLen > maxChars || w.endMs - first.startMs > maxCueMs) flush();
    }
    length += (group.length === 0 ? 0 : 1) + wordLen;
    group.push(w);
    const next = words[i + 1];
    if (SENTENCE_END.test(w.text) || (next !== undefined && next.startMs - w.endMs >= PAUSE_MS)) flush();
  });
  flush();
  return cues;
}

function render(cues: Cue[], separator: ',' | '.'): string {
  return cues
    .map((c, i) => [String(i + 1), formatTimestamp(c.startMs, separator) + ' --> ' + formatTimestamp(c.endMs, separator), c.text].join('\n') + '\n')
    .join('\n');
}

/** SubRip (SRT) text. Cues are numbered from 1 and never overlap. Throws `NO_TIMESTAMPS` for text-only transcripts. */
export function toSrt(t: Transcript, opts: SubtitleOptions = {}): string {
  return render(buildCues(t, opts), ',');
}

/** WebVTT text. Same cues as `toSrt`, with a `WEBVTT` header and `.` in the times. */
export function toVtt(t: Transcript, opts: SubtitleOptions = {}): string {
  return 'WEBVTT\n\n' + render(buildCues(t, opts), '.');
}

/** Plain text. With timestamps, long pauses between segments start a new paragraph. */
export function toText(t: Transcript, opts: TextOptions = {}): string {
  const gap = opts.paragraphGapMs ?? 2000;
  if (!t.hasTimestamps || t.segments.length === 0) return t.text;
  const paragraphs: string[][] = [[]];
  t.segments.forEach((seg, i) => {
    const prev = t.segments[i - 1];
    if (prev && seg.startMs - prev.endMs >= gap) paragraphs.push([]);
    paragraphs[paragraphs.length - 1]!.push(seg.text);
  });
  return paragraphs.map((p) => p.join(' ')).join('\n\n');
}
