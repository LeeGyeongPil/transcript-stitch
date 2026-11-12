import { StitchError } from './errors.js';
import { parseSize } from './time.js';
import type { PlanOptions, PlannedChunk, TimeRange } from './types.js';

function positive(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new StitchError('BAD_INPUT', label + ' must be a positive number, got ' + String(value));
  }
}

function estimateBytes(ms: number, bytesPerSecond: number, headerBytes: number): number {
  return headerBytes + Math.ceil((bytesPerSecond * ms) / 1000 - 1e-6);
}

/**
 * Plan chunks that respect the size and duration limits of a speech-to-text
 * API. Chunk i covers `[cut(i-1) - overlap, cut(i)]`, so neighbours share
 * `overlapMs`. Cuts go into silences when one exists in the allowed range
 * (`cutInSilence`), otherwise at the latest allowed time (`forceSplit`).
 * Throws `PLAN_IMPOSSIBLE` when the limits cannot be met.
 */
export function planChunks(opts: PlanOptions): PlannedChunk[] {
  positive(opts.durationMs, 'durationMs');
  positive(opts.bytesPerSecond, 'bytesPerSecond');
  const maxBytes = parseSize(opts.maxBytes);
  const headerBytes = opts.headerBytes ?? 44;
  const safetyRatio = opts.safetyRatio ?? 0.98;
  const minChunkMs = opts.minChunkMs ?? 10_000;
  const overlapMs = opts.overlapMs ?? 0;
  if (!(safetyRatio > 0 && safetyRatio <= 1)) throw new StitchError('BAD_INPUT', 'safetyRatio must be in (0, 1]');
  if (headerBytes < 0) throw new StitchError('BAD_INPUT', 'headerBytes must be >= 0');
  if (minChunkMs < 0 || overlapMs < 0) throw new StitchError('BAD_INPUT', 'minChunkMs and overlapMs must be >= 0');
  if (opts.maxDurationMs !== undefined) positive(opts.maxDurationMs, 'maxDurationMs');

  const budgetBytes = Math.floor(maxBytes * safetyRatio) - headerBytes;
  if (budgetBytes <= 0) {
    throw new StitchError(
      'PLAN_IMPOSSIBLE',
      'the size limit (' + maxBytes + ' bytes before the safety ratio) is not larger than the ' + headerBytes + '-byte header',
      { reason: 'size_below_header' },
    );
  }
  const bySize = Math.floor((budgetBytes * 1000) / opts.bytesPerSecond);
  const maxChunkMs = Math.min(bySize, opts.maxDurationMs ?? Infinity);
  if (maxChunkMs <= overlapMs) {
    throw new StitchError(
      'PLAN_IMPOSSIBLE',
      'a chunk can hold at most ' + maxChunkMs + ' ms but the overlap alone is ' + overlapMs + ' ms; raise the limits or lower the overlap',
      { reason: 'overlap_too_large' },
    );
  }
  if (maxChunkMs < minChunkMs) {
    throw new StitchError(
      'PLAN_IMPOSSIBLE',
      'a chunk can hold at most ' + maxChunkMs + ' ms, below the minimum chunk length of ' + minChunkMs + ' ms; lower minChunkMs or raise the limits',
      { reason: 'min_exceeds_max' },
    );
  }

  const silences: TimeRange[] = [...(opts.silences ?? [])]
    .filter((s) => s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const chunks: PlannedChunk[] = [];
  let pos = 0; // the previous cut
  const total = Math.round(opts.durationMs);
  for (;;) {
    const first = chunks.length === 0;
    const lead = first ? 0 : overlapMs; // audio re-read before the previous cut
    const start = Math.max(0, pos - lead);
    const step = maxChunkMs - lead;
    if (total - pos <= step) {
      chunks.push({
        index: chunks.length,
        startMs: start,
        endMs: total,
        estBytes: estimateBytes(total - start, opts.bytesPerSecond, headerBytes),
        cutInSilence: false,
        forceSplit: false,
      });
      return chunks;
    }
    const lo = pos + Math.max(1, minChunkMs - lead);
    const hi = pos + step;
    // Latest silence that intersects [lo, hi]; cut in the middle of the overlap with it.
    let cut: number | undefined;
    for (const s of silences) {
      const a = Math.max(s.startMs, lo);
      const b = Math.min(s.endMs, hi);
      if (a <= b && (cut === undefined || Math.floor((a + b) / 2) > cut)) cut = Math.floor((a + b) / 2);
    }
    const inSilence = cut !== undefined;
    const end = Math.floor(cut ?? hi);
    chunks.push({
      index: chunks.length,
      startMs: start,
      endMs: end,
      estBytes: estimateBytes(end - start, opts.bytesPerSecond, headerBytes),
      cutInSilence: inSilence,
      forceSplit: !inSilence,
    });
    pos = end;
  }
}
