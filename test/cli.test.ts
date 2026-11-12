import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWav, toneAndSilence } from './helpers.js';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
let work = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'transcript-stitch-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function cliRun(args: string[], env: Record<string, string> = {}): { code: number | null; out: string; err: string } {
  const r = spawnSync('node', [cli, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TRANSCRIPT_STITCH_LANG: 'en', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('AC-8: stitch', () => {
  const manifest = 'fixtures/probe28/openai/manifest.json';

  it('writes VTT with WEBVTT first and contiguous cue numbers', () => {
    const r = cliRun(['stitch', '--manifest', manifest, '--format', 'vtt']);
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('WEBVTT');
    const numbers = lines.filter((l, i) => /^\d+$/.test(l) && /-->/.test(lines[i + 1] ?? '')).map(Number);
    expect(numbers.length).toBeGreaterThan(3);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
  });

  it('writes SRT, text and JSON, and can write to a file', () => {
    expect(cliRun(['stitch', '--manifest', manifest]).out.startsWith('1\n00:00:00,000 -->')).toBe(true);
    const txt = cliRun(['stitch', '--manifest', manifest, '--format', 'txt']).out;
    expect(txt.trim().split(/\s+/)).toHaveLength(28);
    const json = JSON.parse(cliRun(['stitch', '--manifest', manifest, '--format', 'json']).out) as { words: unknown[]; report: { boundaries: unknown[] } };
    expect(json.words).toHaveLength(28);
    expect(json.report.boundaries).toHaveLength(2);
    const target = join(work, 'out.srt');
    expect(cliRun(['stitch', '--manifest', manifest, '-o', target]).code).toBe(0);
    expect(readFileSync(target, 'utf8')).toContain('upload');
  });

  it('prints the boundary report to stderr with --report', () => {
    const r = cliRun(['stitch', '--manifest', manifest, '--report']);
    expect(r.err).toContain('method');
    expect(r.err).toContain('words');
    expect(r.out).not.toContain('method');
  });

  it('stitches whisper.cpp and text-only manifests and reads .txt chunk files', () => {
    expect(cliRun(['stitch', '--manifest', 'fixtures/probe28/whispercpp/manifest.json', '--format', 'txt']).code).toBe(0);
    const text = cliRun(['stitch', '--manifest', 'fixtures/probe28/text/manifest.json', '--format', 'txt']);
    expect(text.code).toBe(0);
    expect(text.out.trim().split(' ')).toHaveLength(28);
    writeFileSync(join(work, 'a.txt'), 'one two three four');
    writeFileSync(join(work, 'b.txt'), 'three four five six');
    writeFileSync(join(work, 'm.json'), JSON.stringify({ chunks: [{ file: 'a.txt', startMs: 0, endMs: 2000 }, { file: 'b.txt', startMs: 1000, endMs: 3000 }] }));
    expect(cliRun(['stitch', '--manifest', join(work, 'm.json'), '--format', 'txt']).out.trim()).toBe('one two three four five six');
  });

  it('exits 2 with a code for subtitles of text-only responses', () => {
    const r = cliRun(['stitch', '--manifest', 'fixtures/probe28/text/manifest.json']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('error [NO_TIMESTAMPS]');
    expect(r.err).toContain('--format txt');
  });

  it('exits 2 for a missing manifest, a missing chunk file and broken JSON', () => {
    const missing = cliRun(['stitch', '--manifest', join(work, 'nope.json')]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('[FILE_NOT_FOUND]');

    writeFileSync(join(work, 'broken.json'), '{ "chunks": [');
    const broken = cliRun(['stitch', '--manifest', join(work, 'broken.json')]);
    expect(broken.code).toBe(2);
    expect(broken.err).toContain('[BAD_JSON]');

    writeFileSync(join(work, 'm2.json'), JSON.stringify({ chunks: [{ file: 'gone.json', startMs: 0 }] }));
    expect(cliRun(['stitch', '--manifest', join(work, 'm2.json')]).err).toContain('[FILE_NOT_FOUND]');

    writeFileSync(join(work, 'chunk-bad.json'), 'not json at all');
    writeFileSync(join(work, 'm3.json'), JSON.stringify({ chunks: [{ file: 'chunk-bad.json', startMs: 0 }] }));
    const badChunk = cliRun(['stitch', '--manifest', join(work, 'm3.json')]);
    expect(badChunk.code).toBe(2);
    expect(badChunk.err).toContain('[BAD_JSON]');

    writeFileSync(join(work, 'm4.json'), JSON.stringify({ chunks: [{ file: 'a.txt' }] }));
    expect(cliRun(['stitch', '--manifest', join(work, 'm4.json')]).err).toContain('[BAD_MANIFEST]');
    writeFileSync(join(work, 'm5.json'), '{}');
    expect(cliRun(['stitch', '--manifest', join(work, 'm5.json')]).err).toContain('[BAD_MANIFEST]');

    writeFileSync(join(work, 'wrong.json'), JSON.stringify({ hello: 'world' }));
    writeFileSync(join(work, 'm6.json'), JSON.stringify({ chunks: [{ file: 'wrong.json', startMs: 0 }] }));
    expect(cliRun(['stitch', '--manifest', join(work, 'm6.json')]).err).toContain('[UNKNOWN_FORMAT]');

    writeFileSync(join(work, 'm7.json'), JSON.stringify({ chunks: [{ file: 'a.txt', startMs: 5000 }, { file: 'b.txt', startMs: 0 }] }));
    const order = cliRun(['stitch', '--manifest', join(work, 'm7.json'), '--format', 'txt']);
    expect(order.code).toBe(2);
    expect(order.err).toContain('[NON_MONOTONIC]');
    expect(order.err).toContain('Chunk 1');
  });

  it('exits 2 for usage mistakes and shows the hint', () => {
    for (const args of [['stitch'], ['stitch', '--manifest'], ['stitch', '--manifest', 'x', '--format', 'pdf'], ['stitch', '--nope'], ['nope']]) {
      const r = cliRun(args);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.err).toContain('transcript-stitch --help');
    }
  });

  it('--strict exits 1 on warnings but still writes the result', () => {
    writeFileSync(join(work, 'p.txt'), 'alpha beta gamma delta');
    writeFileSync(join(work, 'q.txt'), 'one two three four');
    writeFileSync(join(work, 'ms.json'), JSON.stringify({ chunks: [{ file: 'p.txt', startMs: 0, endMs: 2000 }, { file: 'q.txt', startMs: 1000, endMs: 3000 }] }));
    const loose = cliRun(['stitch', '--manifest', join(work, 'ms.json'), '--format', 'txt']);
    expect(loose.code).toBe(0);
    expect(loose.err).toContain('no matching words');
    const strict = cliRun(['stitch', '--manifest', join(work, 'ms.json'), '--format', 'txt', '--strict']);
    expect(strict.code).toBe(1);
    expect(strict.out.trim()).toBe('alpha beta gamma delta one two three four');
  });

  it('Korean screen shows the warning in Korean', () => {
    writeFileSync(join(work, 'p2.txt'), 'alpha beta gamma delta');
    writeFileSync(join(work, 'q2.txt'), 'one two three four');
    writeFileSync(join(work, 'mk.json'), JSON.stringify({ chunks: [{ file: 'p2.txt', startMs: 0, endMs: 2000 }, { file: 'q2.txt', startMs: 1000, endMs: 3000 }] }));
    const r = cliRun(['stitch', '--manifest', join(work, 'mk.json'), '--format', 'txt', '--report', '--lang', 'ko']);
    expect(r.err).toContain('일치하는 단어를 찾지 못했습니다');
    expect(r.err).toContain('앞 조각');
  });
});

describe('AC-8: plan', () => {
  function wavFile(name: string, totalMs: number): string {
    const path = join(work, name);
    writeFileSync(path, makeWav(toneAndSilence(16_000, totalMs, 6200, 800), 16_000));
    return path;
  }

  it('prints a table, JSON and ffmpeg lines for a WAV file', () => {
    const wav = wavFile('long.wav', 60_000);
    // 32000 bytes/s, 640000 bytes limit -> about 19.6 s per chunk
    const table = cliRun(['plan', wav, '--max-size', '640000', '--overlap', '1s', '--min-chunk', '5s']);
    expect(table.code).toBe(0);
    expect(table.out).toContain('long.wav');
    expect(table.out).toContain('silence');

    const json = JSON.parse(cliRun(['plan', wav, '--max-size', '640000', '--overlap', '1s', '--min-chunk', '5s', '--json']).out) as {
      chunks: { startMs: number; endMs: number; estBytes: number; cutInSilence: boolean }[];
      silences: unknown[];
    };
    expect(json.chunks.length).toBeGreaterThanOrEqual(3);
    expect(json.silences.length).toBeGreaterThanOrEqual(7);
    for (const c of json.chunks) expect(c.estBytes).toBeLessThanOrEqual(640_000 * 0.98);
    expect(json.chunks[0]!.cutInSilence).toBe(true);

    const ff = cliRun(['plan', wav, '--max-size', '640000', '--overlap', '1s', '--min-chunk', '5s', '--ffmpeg']);
    const lines = ff.out.trim().split('\n');
    expect(lines).toHaveLength(json.chunks.length);
    expect(lines[0]).toMatch(/^ffmpeg -ss 0\.000 -t \d+\.\d{3} -i .*long\.wav -c copy long-chunk-000\.wav$/);
  });

  it('exits 3 when no plan is possible', () => {
    const wav = wavFile('imp.wav', 30_000);
    const r = cliRun(['plan', wav, '--max-size', '1000']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('error [PLAN_IMPOSSIBLE]');
    const overlap = cliRun(['plan', wav, '--max-size', '640000', '--overlap', '30s']);
    expect(overlap.code).toBe(3);
  });

  it('exits 2 for a missing file, a non-WAV file and bad values', () => {
    expect(cliRun(['plan', join(work, 'none.wav'), '--max-size', '25mb']).err).toContain('[FILE_NOT_FOUND]');
    writeFileSync(join(work, 'fake.wav'), 'this is not audio');
    const fake = cliRun(['plan', join(work, 'fake.wav'), '--max-size', '25mb']);
    expect(fake.code).toBe(2);
    expect(fake.err).toContain('[BAD_WAV]');
    expect(fake.err).toContain('ffmpeg');
    const wav = wavFile('v.wav', 5000);
    expect(cliRun(['plan', wav]).err).toContain('[USAGE_MISSING_ARG]');
    expect(cliRun(['plan', '--max-size', '25mb']).err).toContain('[USAGE_MISSING_ARG]');
    const bad = cliRun(['plan', wav, '--max-size', 'huge']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('[USAGE_BAD_VALUE]');
    expect(cliRun(['plan', wav, '--max-size', '25mb', '--overlap', 'x']).err).toContain('--overlap');
  });

  it('Korean plan table is aligned and has no English labels', () => {
    const wav = wavFile('ko.wav', 60_000);
    const r = cliRun(['plan', wav, '--max-size', '640000', '--min-chunk', '5s', '--lang', 'ko']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('무음 안');
    expect(r.out).toContain('예상 바이트');
    const lines = r.out.trim().split('\n').slice(2);
    expect(lines.length).toBeGreaterThan(3);
  });
});

describe('demo', () => {
  it('runs without API keys and writes both SRT files', () => {
    const out = join(work, 'demo-out');
    const r = cliRun(['demo', '--out-dir', out], { OPENAI_API_KEY: '', GROQ_API_KEY: '' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('naive: 37 words (9 duplicated)');
    expect(r.out).toContain('stitched: 28 words, 0 duplicated, max drift 0 ms');
    expect(existsSync(join(out, 'naive.srt'))).toBe(true);
    expect(existsSync(join(out, 'stitched.srt'))).toBe(true);
    // naive.srt restarts numbering; stitched.srt does not
    const naive = readFileSync(join(out, 'naive.srt'), 'utf8');
    const stitched = readFileSync(join(out, 'stitched.srt'), 'utf8');
    expect(naive.match(/^1$/gm)).toHaveLength(3);
    expect(stitched.match(/^1$/gm)).toHaveLength(1);
  });
});
