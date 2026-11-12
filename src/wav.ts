import { StitchError } from './errors.js';
import type { SilenceOptions, TimeRange, WavInfo } from './types.js';

function ascii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Read the header of a PCM WAV file. Throws `BAD_WAV` with a hint when the bytes are not usable. */
export function readWavInfo(bytes: Uint8Array): WavInfo {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) {
    throw new StitchError('BAD_WAV', 'not a WAV file: fewer than 12 bytes', { reason: 'too_short' });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
    throw new StitchError('BAD_WAV', 'not a WAV file: missing RIFF/WAVE header; convert it first (for example with ffmpeg -i in.mp3 out.wav)', { reason: 'not_riff' });
  }
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = ascii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (body + 16 > bytes.length) break;
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      if (sampleRate === 0 || channels === 0 || bits === 0) {
        throw new StitchError('BAD_WAV', 'the data chunk comes before the fmt chunk, or fmt is invalid', { reason: 'no_fmt' });
      }
      if (format !== 1 && format !== 0xfffe) {
        throw new StitchError('BAD_WAV', 'unsupported WAV encoding (format ' + format + '); only PCM is supported', { reason: 'not_pcm' });
      }
      // Streamed files may carry 0 or 0xFFFFFFFF as the size; use what is there.
      const declared = size === 0 || size === 0xffffffff ? Infinity : size;
      const dataBytes = Math.min(declared, bytes.length - body);
      const bytesPerSecond = (sampleRate * channels * bits) / 8;
      return {
        sampleRate,
        channels,
        bitsPerSample: bits,
        dataOffset: body,
        dataBytes,
        durationMs: Math.round((dataBytes / bytesPerSecond) * 1000),
      };
    }
    pos = body + size + (size % 2);
  }
  throw new StitchError('BAD_WAV', 'the WAV file has no data chunk', { reason: 'no_data' });
}

/** Decode 16-bit PCM into one channel (the channels are averaged). */
export function readWavSamples(bytes: Uint8Array): { info: WavInfo; samples: Int16Array } {
  const info = readWavInfo(bytes);
  if (info.bitsPerSample !== 16) {
    throw new StitchError(
      'BAD_WAV',
      'only 16-bit PCM can be analysed, this file has ' + info.bitsPerSample + ' bits; convert it (ffmpeg -i in.wav -c:a pcm_s16le out.wav)',
      { reason: 'not_16bit' },
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + info.dataOffset, info.dataBytes);
  const frames = Math.floor(info.dataBytes / (2 * info.channels));
  const samples = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < info.channels; c++) sum += view.getInt16((f * info.channels + c) * 2, true);
    samples[f] = Math.round(sum / info.channels);
  }
  return { info, samples };
}

/**
 * Find silent ranges by frame RMS energy. Ranges start and end on frame
 * boundaries, so they are exact to one frame (default 20 ms).
 */
export function detectSilences(samples: Float32Array | Int16Array, sampleRate: number, opts: SilenceOptions = {}): TimeRange[] {
  const thresholdDb = opts.thresholdDb ?? -40;
  const minSilenceMs = opts.minSilenceMs ?? 400;
  const frameMs = opts.frameMs ?? 20;
  if (!(sampleRate > 0)) throw new StitchError('BAD_INPUT', 'sampleRate must be positive');
  if (!(frameMs > 0)) throw new StitchError('BAD_INPUT', 'frameMs must be positive');
  const full = samples instanceof Int16Array ? 32768 : 1;
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.ceil(samples.length / frameLen);
  const totalMs = Math.round((samples.length / sampleRate) * 1000);
  const result: TimeRange[] = [];
  let runStart = -1;
  const close = (endFrame: number): void => {
    if (runStart < 0) return;
    const startMs = Math.round((runStart * frameLen * 1000) / sampleRate);
    const endMs = Math.min(totalMs, Math.round((endFrame * frameLen * 1000) / sampleRate));
    if (endMs - startMs >= minSilenceMs) result.push({ startMs, endMs });
    runStart = -1;
  };
  for (let f = 0; f < frames; f++) {
    const from = f * frameLen;
    const to = Math.min(samples.length, from + frameLen);
    let sum = 0;
    for (let i = from; i < to; i++) {
      const v = samples[i]! / full;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (to - from));
    const db = rms === 0 ? -Infinity : 20 * Math.log10(rms);
    if (db < thresholdDb) {
      if (runStart < 0) runStart = f;
    } else {
      close(f);
    }
  }
  close(frames);
  return result;
}
