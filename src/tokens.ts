/** Comparison key: NFKC, lower case, letters and digits only. Empty for pure punctuation. */
export function keyOf(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}

/**
 * True when `a` looks like a cut-off piece of `b` (a prefix or a suffix, at
 * least two characters, strictly shorter). Both arguments are keys.
 */
export function isFragmentOf(a: string, b: string): boolean {
  return a.length >= 2 && a.length < b.length && (b.startsWith(a) || b.endsWith(a));
}

/** Split plain text into whitespace separated tokens. */
export function tokenize(text: string): string[] {
  return text.split(/\s+/u).filter((t) => t.length > 0);
}

export interface RawToken {
  word: string;
  start: number;
  end: number;
  probability?: number;
}

export interface RawWord {
  text: string;
  start: number;
  end: number;
  probability?: number;
}

const SPECIAL_TOKEN = /^\s*(\[_[A-Z_0-9]+_?\]|<\|[^|]*\|>)\s*$/u;

/**
 * Group whisper.cpp sub-word tokens into words. A token that starts with
 * whitespace begins a new word; other tokens (for example `lo` after ` hel`,
 * or punctuation) are appended to the current word. Times are in seconds.
 */
export function groupTokens(tokens: RawToken[]): RawWord[] {
  const words: RawWord[] = [];
  let current: RawWord | undefined;
  for (const token of tokens) {
    if (SPECIAL_TOKEN.test(token.word)) continue;
    const startsWord = /^\s/u.test(token.word) || current === undefined;
    const piece = token.word.trim();
    if (piece === '') continue;
    if (startsWord) {
      current = { text: piece, start: token.start, end: token.end };
      if (token.probability !== undefined) current.probability = token.probability;
      words.push(current);
    } else if (current) {
      current.text += piece;
      current.end = token.end;
      if (token.probability !== undefined) {
        current.probability = current.probability === undefined ? token.probability : Math.min(current.probability, token.probability);
      }
    }
  }
  return words;
}

/** Default Jaro-Winkler threshold used by `fuzzy: true`. */
export const DEFAULT_FUZZY_THRESHOLD = 0.85;
/** Keys shorter than this are only ever compared exactly (avoids aligning short words by accident). */
export const FUZZY_MIN_KEY_LENGTH = 3;

/** Jaro-Winkler similarity of two keys, from 0 (different) to 1 (equal). Pure and deterministic. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0 || y.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(x.length, y.length) / 2) - 1);
  const xm = new Array<boolean>(x.length).fill(false);
  const ym = new Array<boolean>(y.length).fill(false);
  let matches = 0;
  for (let i = 0; i < x.length; i++) {
    const from = Math.max(0, i - range);
    const to = Math.min(y.length - 1, i + range);
    for (let j = from; j <= to; j++) {
      if (ym[j] || x[i] !== y[j]) continue;
      xm[i] = true;
      ym[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    if (!xm[i]) continue;
    while (!ym[k]) k++;
    if (x[i] !== y[k]) transpositions++;
    k++;
  }
  const jaro = (matches / x.length + matches / y.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < x.length && prefix < y.length && x[prefix] === y[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * True when two keys are close enough to count as the same word under a
 * threshold. Keys shorter than 3 characters never match approximately.
 */
export function fuzzyKeyMatch(a: string, b: string, threshold: number): boolean {
  if (Array.from(a).length < FUZZY_MIN_KEY_LENGTH || Array.from(b).length < FUZZY_MIN_KEY_LENGTH) return false;
  return jaroWinkler(a, b) >= threshold;
}
