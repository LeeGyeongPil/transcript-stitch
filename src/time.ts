import { StitchError } from './errors.js';

/** Round to an integer millisecond, rejecting NaN and Infinity. */
export function roundMs(value: number, what = 'time'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StitchError('BAD_INPUT', `${what} must be a finite number of milliseconds, got ${String(value)}`);
  }
  return Math.round(value);
}

/** Seconds (as returned by the APIs) to integer milliseconds. */
export function secToMs(value: unknown, what = 'time'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StitchError('UNKNOWN_FORMAT', `${what} must be a finite number of seconds, got ${String(value)}`);
  }
  return Math.round(value * 1000);
}

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
};

/** Parse `25mb` (decimal), `24mib` (binary) or a plain byte count. */
export function parseSize(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new StitchError('BAD_INPUT', `size must be a positive number of bytes, got ${String(value)}`);
    }
    return Math.floor(value);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  const unit = m ? (m[2] === '' ? 'b' : m[2]!.toLowerCase()) : '';
  const factor = SIZE_UNITS[unit];
  if (!m || factor === undefined || Number(m[1]) <= 0) {
    throw new StitchError('BAD_INPUT', `cannot read size "${value}"; use a number of bytes or a value like 25mb, 24mib, 512kb`);
  }
  return Math.floor(Number(m[1]) * factor);
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Parse `1.5s`, `20m`, `90ms`, `1h` or a plain millisecond count. */
export function parseDuration(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new StitchError('BAD_INPUT', `duration must be a non-negative number of milliseconds, got ${String(value)}`);
    }
    return Math.round(value);
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  const unit = m ? (m[2] === '' ? 'ms' : m[2]!.toLowerCase()) : '';
  const factor = DURATION_UNITS[unit];
  if (!m || factor === undefined) {
    throw new StitchError('BAD_INPUT', `cannot read duration "${value}"; use a value like 1.5s, 20m, 90ms, 1h`);
  }
  return Math.round(Number(m[1]) * factor);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** `HH:MM:SS,mmm` for SRT and `HH:MM:SS.mmm` for WebVTT. */
export function formatTimestamp(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(total % 1000, 3)}`;
}
