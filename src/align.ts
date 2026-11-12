/** A run of equal items: `len` items starting at `i` in the left list and `j` in the right list. */
export interface Run {
  i: number;
  j: number;
  len: number;
}

/**
 * Find the longest run of consecutive matching items between two lists.
 * `eq` decides whether item i on the left equals item j on the right.
 * Ties are broken by the smaller `cost` (for example distance from the
 * middle of the overlap), then by the earlier position. Deterministic.
 */
export function longestCommonRun(
  nLeft: number,
  nRight: number,
  eq: (i: number, j: number) => boolean,
  cost: (run: Run) => number = () => 0,
): Run | undefined {
  let best: Run | undefined;
  let bestCost = Infinity;
  let prev = new Array<number>(nRight + 1).fill(0);
  for (let i = 0; i < nLeft; i++) {
    const row = new Array<number>(nRight + 1).fill(0);
    for (let j = 0; j < nRight; j++) {
      if (!eq(i, j)) continue;
      const len = (prev[j] ?? 0) + 1;
      row[j + 1] = len;
      const run: Run = { i: i - len + 1, j: j - len + 1, len };
      if (best === undefined || len > best.len) {
        best = run;
        bestCost = cost(run);
      } else if (len === best.len) {
        const c = cost(run);
        if (c < bestCost) {
          best = run;
          bestCost = c;
        }
      }
    }
    prev = row;
  }
  return best;
}
