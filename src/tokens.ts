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
