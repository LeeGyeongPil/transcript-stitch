/** Number of terminal columns a character takes: 2 for East Asian wide characters, 0 for combining marks. */
function charWidth(cp: number): number {
  if (cp === 0 || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

/** Display width of a string in terminal columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text.normalize('NFC')) width += charWidth(ch.codePointAt(0) as number);
  return width;
}

export function padEndWidth(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

export function padStartWidth(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(text))) + text;
}

/**
 * Render a plain text table. Columns are padded by display width, so Korean
 * headers and cells line up. `align` is `l` (default) or `r` per column.
 */
export function renderTable(headers: string[], rows: string[][], align: ('l' | 'r')[] = []): string {
  const widths = headers.map((h, c) => Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[c] ?? ''))));
  const line = (cells: string[]): string =>
    cells
      .map((cell, c) => (align[c] === 'r' ? padStartWidth(cell, widths[c]!) : padEndWidth(cell, widths[c]!)))
      .join('  ');
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), rule, ...rows.map(line)].join('\n');
}
