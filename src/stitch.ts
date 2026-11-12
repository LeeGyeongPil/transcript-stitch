import { longestCommonRun, type Run } from './align.js';
import { StitchError } from './errors.js';
import { normalize } from './normalize.js';
import { roundMs } from './time.js';
import { isFragmentOf, keyOf, tokenize } from './tokens.js';
import type {
  BoundaryReport,
  ChunkInput,
  Segment,
  Stitched,
  StitchOptions,
  StitchWarning,
  Transcript,
  Word,
} from './types.js';

type Required_ = Required<StitchOptions>;

interface Prepared {
  index: number;
  offsetMs: number;
  endMs: number | undefined;
  reportedOverlapMs: number | undefined;
  transcript: Transcript;
}

/** Token used by the text-only path. */
interface TextToken {
  text: string;
  chunk: number;
}

const SENTENCE_END = /[.!?…。！？]["')\]]*$/u;
const SEGMENT_PAUSE_MS = 1000;
const DEFAULT_TEXT_WINDOW = 40;

function resolveOptions(opts: StitchOptions): Required_ {
  const merged: Required_ = {
    minMatchWords: opts.minMatchWords ?? 2,
    windowSlackMs: opts.windowSlackMs ?? 500,
    maxWordDriftMs: opts.maxWordDriftMs ?? 300,
    onNoMatch: opts.onNoMatch ?? 'midpoint',
  };
  if (!Number.isInteger(merged.minMatchWords) || merged.minMatchWords < 1) {
    throw new StitchError('BAD_INPUT', 'minMatchWords must be an integer >= 1');
  }
  if (merged.windowSlackMs < 0 || merged.maxWordDriftMs < 0) {
    throw new StitchError('BAD_INPUT', 'windowSlackMs and maxWordDriftMs must be >= 0');
  }
  if (merged.onNoMatch !== 'midpoint' && merged.onNoMatch !== 'keep-both') {
    throw new StitchError('BAD_INPUT', 'onNoMatch must be "midpoint" or "keep-both"');
  }
  return merged;
}

function prepare(chunks: ChunkInput[]): Prepared[] {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new StitchError('BAD_INPUT', 'chunks must be a non-empty array of { startMs, result }');
  }
  let previous = -Infinity;
  return chunks.map((chunk, index) => {
    if (typeof chunk !== 'object' || chunk === null || !('result' in chunk)) {
      throw new StitchError('BAD_INPUT', `chunk ${index} must be an object with startMs and result`, { index });
    }
    const offsetMs = roundMs(chunk.startMs, `chunks[${index}].startMs`);
    if (offsetMs < previous) {
      throw new StitchError('NON_MONOTONIC', `chunk ${index} starts at ${offsetMs} ms, before the previous chunk (${previous} ms); pass chunks in time order`, { index });
    }
    previous = offsetMs;
    const transcript = normalize(chunk.result, chunk.provider ? { provider: chunk.provider } : {});
    return {
      index,
      offsetMs,
      endMs: chunk.endMs === undefined ? undefined : roundMs(chunk.endMs, `chunks[${index}].endMs`),
      reportedOverlapMs: chunk.overlapMs === undefined ? undefined : roundMs(chunk.overlapMs, `chunks[${index}].overlapMs`),
      transcript,
    };
  });
}

function shiftWords(p: Prepared): Word[] {
  return (p.transcript.words ?? []).map((w) => ({ ...w, chunk: p.index, startMs: w.startMs + p.offsetMs, endMs: w.endMs + p.offsetMs }));
}

function warning(code: StitchWarning['code'], message: string, boundary: number | undefined, data: StitchWarning['data']): StitchWarning {
  const w: StitchWarning = { code, message, data };
  if (boundary !== undefined) w.boundary = boundary;
  return w;
}

/** Keep the left items before the run middle and the right items after it. */
function spliceRun<T extends { text: string }>(
  left: T[],
  right: T[],
  tailIdx: number[],
  headIdx: number[],
  run: Run,
): { merged: T[]; droppedLeft: number; droppedRight: number } {
  const m = Math.floor(run.len / 2);
  const cutLeft = tailIdx[run.i + m]!;
  const cutRight = headIdx[run.j + m]!;
  const keptLeft = left.slice(0, cutLeft);
  const keptRight = right.slice(cutRight);
  for (let k = 0; k < run.len; k++) {
    const li = tailIdx[run.i + k]!;
    const ri = headIdx[run.j + k]!;
    const a = left[li]!;
    const b = right[ri]!;
    // Prefer the whole word over a cut-off piece of it.
    if (k < m && isFragmentOf(keyOf(a.text), keyOf(b.text))) keptLeft[li] = b;
    if (k >= m && isFragmentOf(keyOf(b.text), keyOf(a.text))) keptRight[ri - cutRight] = a;
  }
  return { merged: keptLeft.concat(keptRight), droppedLeft: left.length - cutLeft, droppedRight: cutRight };
}

function indicesWithKey<T extends { text: string }>(items: T[], from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) if (keyOf(items[i]!.text) !== '') out.push(i);
  return out;
}

function center(w: Word): number {
  return (w.startMs + w.endMs) / 2;
}

/** Cut each overlap in the middle of the matching words; fall back to the middle of the time overlap. */
function stitchTimed(prepared: Prepared[], o: Required_): { words: Word[]; boundaries: BoundaryReport[]; warnings: StitchWarning[] } {
  let out: Word[] = [];
  const boundaries: BoundaryReport[] = [];
  const warnings: StitchWarning[] = [];

  prepared.forEach((p, ci) => {
    const words = shiftWords(p);
    if (ci === 0) {
      out = words;
      return;
    }
    const prev = prepared[ci - 1]!;
    const prevWords = shiftWords(prev);
    const prevEnd = prev.endMs ?? (prevWords.length > 0 ? prevWords[prevWords.length - 1]!.endMs : undefined);
    const b = ci - 1;
    const report: BoundaryReport = { left: b, right: ci, actualOverlapMs: 0, method: 'adjacent', matchedWords: 0, droppedLeft: 0, droppedRight: 0, warnings: [] };
    if (p.reportedOverlapMs !== undefined) report.reportedOverlapMs = p.reportedOverlapMs;
    const add = (w: StitchWarning): void => {
      report.warnings.push(w);
      warnings.push(w);
    };

    if (words.length === 0 || prevWords.length === 0) {
      add(warning('EMPTY_CHUNK', `chunk ${words.length === 0 ? ci : b} has no words; chunks are joined as they are`, b, { chunk: words.length === 0 ? ci : b }));
    }
    if (prevEnd === undefined) {
      add(warning('UNKNOWN_END', `chunk ${b} has no endMs and no words, so the overlap with chunk ${ci} is unknown`, b, { chunk: b }));
    }
    const actual = prevEnd === undefined ? 0 : prevEnd - p.offsetMs;
    report.actualOverlapMs = Math.max(0, actual);
    if (p.reportedOverlapMs !== undefined && p.reportedOverlapMs !== report.actualOverlapMs) {
      add(warning('REPORTED_OVERLAP_DIFFERS', `the splitter reported an overlap of ${p.reportedOverlapMs} ms but the boundary times give ${report.actualOverlapMs} ms; using the boundary times`, b, { left: b, right: ci, reportedMs: p.reportedOverlapMs, actualMs: report.actualOverlapMs }));
    }
    if (actual < 0) {
      add(warning('GAP', `there is a ${-actual} ms gap between chunk ${b} and chunk ${ci}; that audio was never transcribed`, b, { left: b, right: ci, gapMs: -actual }));
    }

    if (actual <= 0 || words.length === 0 || out.length === 0) {
      out = out.concat(words);
      boundaries.push(report);
      return;
    }

    // Candidate words near the overlap on both sides.
    const tailFrom = out.findIndex((w) => w.endMs > p.offsetMs - o.windowSlackMs);
    const tailIdx = tailFrom < 0 ? [] : indicesWithKey(out, tailFrom, out.length);
    let headTo = words.findIndex((w) => w.startMs >= (prevEnd as number) + o.windowSlackMs);
    if (headTo < 0) headTo = words.length;
    const headIdx = indicesWithKey(words, 0, headTo);

    const overlapMid = (p.offsetMs + (prevEnd as number)) / 2;
    const eq = (i: number, j: number): boolean => {
      const a = out[tailIdx[i]!]!;
      const c = words[headIdx[j]!]!;
      const ka = keyOf(a.text);
      const kc = keyOf(c.text);
      if (ka === kc) return Math.abs(a.startMs - c.startMs) <= o.maxWordDriftMs;
      // A word cut off by the end of the left chunk: the piece is a prefix of the whole word.
      if (i === tailIdx.length - 1 && isFragmentOf(ka, kc) && kc.startsWith(ka)) return Math.abs(a.startMs - c.startMs) <= o.maxWordDriftMs;
      // A word cut off by the start of the right chunk: the piece is a suffix.
      if (j === 0 && isFragmentOf(kc, ka) && ka.endsWith(kc)) return Math.abs(a.endMs - c.endMs) <= o.maxWordDriftMs;
      return false;
    };
    const cost = (run: Run): number => {
      const first = out[tailIdx[run.i]!]!;
      const last = out[tailIdx[run.i + run.len - 1]!]!;
      return Math.abs((first.startMs + last.endMs) / 2 - overlapMid);
    };
    const run = longestCommonRun(tailIdx.length, headIdx.length, eq, cost);

    if (run && run.len >= o.minMatchWords) {
      const r = spliceRun(out, words, tailIdx, headIdx, run);
      out = r.merged;
      report.method = 'words';
      report.matchedWords = run.len;
      report.droppedLeft = r.droppedLeft;
      report.droppedRight = r.droppedRight;
      boundaries.push(report);
      return;
    }

    if (o.onNoMatch === 'keep-both') {
      add(warning('NO_MATCH', `no matching words in the ${report.actualOverlapMs} ms overlap between chunk ${b} and chunk ${ci}; keeping both sides`, b, { left: b, right: ci, overlapMs: report.actualOverlapMs }));
      out = out.concat(words);
      report.method = 'midpoint';
      boundaries.push(report);
      return;
    }
    const mid = Math.round(overlapMid);
    let cutLeft = out.findIndex((w) => center(w) >= mid);
    if (cutLeft < 0) cutLeft = out.length;
    let cutRight = words.findIndex((w) => center(w) >= mid);
    if (cutRight < 0) cutRight = words.length;
    report.droppedLeft = out.length - cutLeft;
    report.droppedRight = cutRight;
    out = out.slice(0, cutLeft).concat(words.slice(cutRight));
    report.method = 'midpoint';
    add(warning('NO_MATCH', `no matching words in the ${report.actualOverlapMs} ms overlap between chunk ${b} and chunk ${ci}; cut at the midpoint (${mid} ms)`, b, { left: b, right: ci, overlapMs: report.actualOverlapMs, midMs: mid }));
    boundaries.push(report);
  });

  // Words must not run backwards after cutting and joining.
  let lastStart = 0;
  for (const w of out) {
    if (w.startMs < lastStart) w.startMs = lastStart;
    if (w.endMs < w.startMs) w.endMs = w.startMs;
    lastStart = w.startMs;
  }
  return { words: out, boundaries, warnings };
}

/** Text-only responses: align tokens near the boundary, sized by the time overlap. */
function stitchText(prepared: Prepared[], o: Required_): { tokens: TextToken[]; boundaries: BoundaryReport[]; warnings: StitchWarning[] } {
  let out: TextToken[] = [];
  const boundaries: BoundaryReport[] = [];
  const warnings: StitchWarning[] = [];

  prepared.forEach((p, ci) => {
    const tokens: TextToken[] = tokenize(p.transcript.text).map((text) => ({ text, chunk: ci }));
    if (ci === 0) {
      out = tokens;
      return;
    }
    const prev = prepared[ci - 1]!;
    const b = ci - 1;
    const report: BoundaryReport = { left: b, right: ci, actualOverlapMs: 0, method: 'adjacent', matchedWords: 0, droppedLeft: 0, droppedRight: 0, warnings: [] };
    if (p.reportedOverlapMs !== undefined) report.reportedOverlapMs = p.reportedOverlapMs;
    const add = (w: StitchWarning): void => {
      report.warnings.push(w);
      warnings.push(w);
    };
    const known = prev.endMs !== undefined && p.endMs !== undefined;
    let tailSize = DEFAULT_TEXT_WINDOW;
    let headSize = DEFAULT_TEXT_WINDOW;
    if (prev.endMs === undefined) {
      add(warning('UNKNOWN_END', `chunk ${b} has no endMs, so the overlap with chunk ${ci} is unknown; using a window of ${DEFAULT_TEXT_WINDOW} tokens`, b, { chunk: b }));
    } else {
      const actual = prev.endMs - p.offsetMs;
      report.actualOverlapMs = Math.max(0, actual);
      if (p.reportedOverlapMs !== undefined && p.reportedOverlapMs !== report.actualOverlapMs) {
        add(warning('REPORTED_OVERLAP_DIFFERS', `the splitter reported an overlap of ${p.reportedOverlapMs} ms but the boundary times give ${report.actualOverlapMs} ms; using the boundary times`, b, { left: b, right: ci, reportedMs: p.reportedOverlapMs, actualMs: report.actualOverlapMs }));
      }
      if (actual < 0) {
        add(warning('GAP', `there is a ${-actual} ms gap between chunk ${b} and chunk ${ci}; that audio was never transcribed`, b, { left: b, right: ci, gapMs: -actual }));
      }
      if (actual <= 0) {
        out = out.concat(tokens);
        boundaries.push(report);
        return;
      }
      const prevDur = Math.max(1, prev.endMs - prev.offsetMs);
      const leftCount = out.filter((t) => t.chunk === b).length;
      tailSize = Math.min(out.length, Math.ceil((leftCount * actual) / prevDur) + 2);
      if (known) {
        const curDur = Math.max(1, (p.endMs as number) - p.offsetMs);
        headSize = Math.min(tokens.length, Math.ceil((tokens.length * actual) / curDur) + 2);
      }
    }
    tailSize = Math.min(tailSize, out.length);
    headSize = Math.min(headSize, tokens.length);

    const tailIdx = indicesWithKey(out, out.length - tailSize, out.length);
    const headIdx = indicesWithKey(tokens, 0, headSize);
    const eq = (i: number, j: number): boolean => {
      const ka = keyOf(out[tailIdx[i]!]!.text);
      const kc = keyOf(tokens[headIdx[j]!]!.text);
      if (ka === kc) return true;
      if (i === tailIdx.length - 1 && isFragmentOf(ka, kc) && kc.startsWith(ka)) return true;
      return j === 0 && isFragmentOf(kc, ka) && ka.endsWith(kc);
    };
    const run = longestCommonRun(tailIdx.length, headIdx.length, eq);
    if (run && run.len >= o.minMatchWords) {
      const r = spliceRun(out, tokens, tailIdx, headIdx, run);
      out = r.merged;
      report.method = 'text';
      report.matchedWords = run.len;
      report.droppedLeft = r.droppedLeft;
      report.droppedRight = r.droppedRight;
    } else {
      add(warning('NO_MATCH', `no matching words near the boundary between chunk ${b} and chunk ${ci}; keeping both sides (text without timestamps cannot be cut by time)`, b, { left: b, right: ci, overlapMs: report.actualOverlapMs }));
      out = out.concat(tokens);
      report.method = 'text';
    }
    boundaries.push(report);
  });
  return { tokens: out, boundaries, warnings };
}

/** Build segments from the final word list: break at sentence ends and long pauses. */
function rebuildSegments(words: Word[]): Segment[] {
  const segments: Segment[] = [];
  let group: Word[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    segments.push({
      text: group.map((w) => w.text).join(' '),
      startMs: group[0]!.startMs,
      endMs: group[group.length - 1]!.endMs,
      chunk: group[0]!.chunk,
      words: group,
    });
    group = [];
  };
  words.forEach((w, i) => {
    group.push(w);
    const next = words[i + 1];
    if (SENTENCE_END.test(w.text) || (next !== undefined && next.startMs - w.endMs >= SEGMENT_PAUSE_MS)) flush();
  });
  flush();
  return segments;
}

/**
 * Merge per-chunk transcription responses into one transcript with absolute
 * times: add each chunk offset, compute the real overlap from the chunk
 * boundary times, remove words heard twice and keep whole words over pieces.
 * Deterministic: the same input always gives the same output.
 */
export function stitch(chunks: ChunkInput[], opts: StitchOptions = {}): Stitched {
  const o = resolveOptions(opts);
  const prepared = prepare(chunks);
  const timed = prepared.every((p) => p.transcript.hasTimestamps);
  const globalWarnings: StitchWarning[] = [];
  if (!timed && prepared.some((p) => p.transcript.hasTimestamps)) {
    globalWarnings.push(warning('MIXED_TIMESTAMPS', 'some chunks have timestamps and some do not; stitching by text and dropping all timestamps', undefined, {}));
  }
  if (timed) {
    const r = stitchTimed(prepared, o);
    return {
      text: r.words.map((w) => w.text).join(' '),
      segments: rebuildSegments(r.words),
      words: r.words,
      hasTimestamps: true,
      report: { boundaries: r.boundaries, warnings: r.warnings },
    };
  }
  const r = stitchText(prepared, o);
  return {
    text: r.tokens.map((t) => t.text).join(' '),
    segments: [],
    hasTimestamps: false,
    report: { boundaries: r.boundaries, warnings: globalWarnings.concat(r.warnings) },
  };
}

/**
 * The hand-rolled approach, for comparison: fix the chunk offsets and
 * concatenate. It keeps every duplicated word.
 */
export function naiveConcat(chunks: ChunkInput[]): Stitched {
  const prepared = prepare(chunks);
  const timed = prepared.every((p) => p.transcript.hasTimestamps);
  if (timed) {
    const words = prepared.flatMap(shiftWords);
    return { text: words.map((w) => w.text).join(' '), segments: rebuildSegments(words), words, hasTimestamps: true, report: { boundaries: [], warnings: [] } };
  }
  const text = prepared.map((p) => p.transcript.text).join(' ');
  return { text, segments: [], hasTimestamps: false, report: { boundaries: [], warnings: [] } };
}
