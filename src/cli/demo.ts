import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { naiveConcat, normalize, stitch, toSrt } from '../index.js';
import type { ChunkInput, Stitched } from '../index.js';
import { t, type Lang } from './i18n.js';
import { boundaryTable } from './report.js';

interface TruthWord {
  text: string;
  startMs: number;
}

function key(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/**
 * Compare a word list with the truth by longest common subsequence.
 * `duplicated` = words in the output that match nothing in the truth
 * (repeats and pieces). `drift` = largest start-time error among matched words.
 */
export function scoreAgainstTruth(words: { text: string; startMs: number }[], truth: TruthWord[]): { words: number; duplicated: number; drift: number } {
  const a = words.map((w) => key(w.text));
  const b = truth.map((w) => key(w.text));
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  let matched = 0;
  let drift = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      drift = Math.max(drift, Math.abs(words[i]!.startMs - truth[j]!.startMs));
      matched++;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return { words: words.length, duplicated: words.length - matched, drift };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Load the built-in practice chunks (fixtures/probe28, OpenAI format) and their truth. */
function loadPractice(): { chunks: ChunkInput[]; truth: TruthWord[] } {
  const base = fileURLToPath(new URL('../../fixtures/probe28/', import.meta.url));
  const manifest = readJson(join(base, 'openai', 'manifest.json')) as { chunks: { file: string; startMs: number; endMs: number; overlapMs?: number }[] };
  const chunks = manifest.chunks.map((c) => {
    const input: ChunkInput = { startMs: c.startMs, endMs: c.endMs, result: readJson(join(base, 'openai', c.file)) };
    if (c.overlapMs !== undefined) input.overlapMs = c.overlapMs;
    return input;
  });
  const truth = (readJson(join(base, 'truth.json')) as { words: TruthWord[] }).words;
  return { chunks, truth };
}

/** What hand-written code often produces: every chunk's own SRT pasted one after another. */
function pastedSrt(chunks: ChunkInput[]): string {
  return chunks.map((c) => toSrt(normalize(c.result))).join('\n');
}

export interface DemoResult {
  naive: { words: number; duplicated: number; drift: number };
  stitched: { words: number; duplicated: number; drift: number };
  stitchedResult: Stitched;
}

/** Run the mock-mode demo. `print` receives one line at a time. */
export function runDemo(lang: Lang, outDir: string, print: (line: string) => void, shownDir: string = outDir): DemoResult {
  const { chunks, truth } = loadPractice();
  const naive = naiveConcat(chunks);
  const stitched = stitch(chunks);
  const naiveScore = scoreAgainstTruth(naive.words ?? [], truth);
  const stitchedScore = scoreAgainstTruth(stitched.words ?? [], truth);

  print(t(lang, 'demo.banner'));
  print('');
  print(t(lang, 'demo.truth', { words: truth.length }));
  print(t(lang, 'demo.naive', { words: naiveScore.words, dup: naiveScore.duplicated }));
  print(t(lang, 'demo.stitched', { words: stitchedScore.words, dup: stitchedScore.duplicated, drift: stitchedScore.drift }));
  print('');
  print(t(lang, 'demo.boundaries'));
  print(boundaryTable(lang, stitched.report));

  mkdirSync(outDir, { recursive: true });
  const naivePath = join(outDir, 'naive.srt');
  const stitchedPath = join(outDir, 'stitched.srt');
  writeFileSync(naivePath, pastedSrt(chunks));
  writeFileSync(stitchedPath, toSrt(stitched));
  print('');
  print(t(lang, 'demo.wrote', { path: join(shownDir, 'naive.srt') }));
  print('  ' + t(lang, 'demo.naiveSrt'));
  print(t(lang, 'demo.wrote', { path: join(shownDir, 'stitched.srt') }));
  print('  ' + t(lang, 'demo.stitchedSrt'));
  return { naive: naiveScore, stitched: stitchedScore, stitchedResult: stitched };
}
