import type { StitchReport, StitchWarning } from '../index.js';
import { t, type Lang } from './i18n.js';
import type { MessageKey } from './messages/en.js';
import { renderTable } from './table.js';

/** The boundary table, aligned by display width so Korean and English both line up. */
export function boundaryTable(lang: Lang, report: StitchReport): string {
  const headers = [
    t(lang, 'report.left'),
    t(lang, 'report.right'),
    t(lang, 'report.method'),
    t(lang, 'report.actual'),
    t(lang, 'report.reported'),
    t(lang, 'report.matched'),
    t(lang, 'report.droppedLeft'),
    t(lang, 'report.droppedRight'),
  ];
  const rows = report.boundaries.map((b) => [
    String(b.left),
    String(b.right),
    t(lang, `report.method.${b.method}` as MessageKey),
    String(b.actualOverlapMs),
    b.reportedOverlapMs === undefined ? t(lang, 'report.none') : String(b.reportedOverlapMs),
    String(b.matchedWords),
    String(b.droppedLeft),
    String(b.droppedRight),
  ]);
  return renderTable(headers, rows, ['r', 'r', 'l', 'r', 'r', 'r', 'r', 'r']);
}

export function warningLine(lang: Lang, w: StitchWarning): string {
  return t(lang, `warning.${w.code}` as MessageKey, w.data);
}

/** The report as text: the table, then localized warnings. */
export function reportText(lang: Lang, report: StitchReport): string {
  const lines = [boundaryTable(lang, report)];
  if (report.warnings.length > 0) {
    lines.push('', t(lang, 'report.warnings'));
    for (const w of report.warnings) lines.push('  - ' + warningLine(lang, w));
  }
  return lines.join('\n');
}
