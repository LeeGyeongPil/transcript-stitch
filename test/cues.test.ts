import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StitchError, normalize } from '../src/index.js';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');
let work = '';

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'transcript-stitch-cues-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

function cliRun(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync('node', [cli, ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TRANSCRIPT_STITCH_LANG: 'en' } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nhello brave\nnew world\n\n2\n00:00:03,500 --> 00:00:04,000\n<i>again</i>\n';

describe('SRT/VTT input: normalize', () => {
  it('parses SRT cues into segments and estimated words', () => {
    const t = normalize(SRT, { provider: 'srt' });
    expect(t.hasTimestamps).toBe(true);
    expect(t.segments.map((s) => [s.text, s.startMs, s.endMs, s.chunk])).toEqual([
      ['hello brave new world', 1000, 3000, 0],
      ['again', 3500, 4000, 0],
    ]);
    expect(t.words).toHaveLength(5);
    expect(t.words?.every((w) => w.estimated === true)).toBe(true);
    expect(t.words?.[0]).toMatchObject({ text: 'hello', startMs: 1000, endMs: 1500 });
    expect(t.text).toBe('hello brave new world again');
  });

  it('handles BOM, CRLF, WEBVTT header, NOTE/STYLE blocks, cue settings and short times', () => {
    const vtt =
      '\uFEFFWEBVTT - title\r\n\r\nNOTE a comment\r\nsecond line\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nintro\r\n00:01.500 --> 00:03.250 align:start position:10%\r\n<v Bob>hi there</v>\r\n\r\n01:00:00.000 --> 01:00:01.000\r\nlate\r\n';
    const t = normalize(vtt, { provider: 'vtt' });
    expect(t.segments.map((s) => [s.text, s.startMs, s.endMs])).toEqual([
      ['hi there', 1500, 3250],
      ['late', 3600000, 3601000],
    ]);
  });

  it('throws UNKNOWN_FORMAT for bad timestamps and non-string input', () => {
    expect(() => normalize('1\n00:00:xx,000 --> 00:00:02,000\nhi', { provider: 'srt' })).toThrow(StitchError);
    try {
      normalize('1\n00:00:01,000 --> 00:99:02,000\nhi', { provider: 'srt' });
      expect.unreachable();
    } catch (e) {
      expect((e as StitchError).code).toBe('UNKNOWN_FORMAT');
    }
    expect(() => normalize({ text: 'x' }, { provider: 'vtt' })).toThrow(/cue file as a string/);
  });

  it('skips WEBVTT header metadata lines such as Kind and Language', () => {
    const t = normalize('WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:01.500\nhi\n', { provider: 'vtt' });
    expect(t.segments.map((s) => [s.text, s.startMs, s.endMs])).toEqual([['hi', 0, 1500]]);
  });

  it('splits SRT cues that have no blank line between them', () => {
    const t = normalize('1\n00:00:00,000 --> 00:00:01,000\na\n2\n00:00:01,000 --> 00:00:02,000\nb\n', { provider: 'srt' });
    expect(t.segments.map((s) => [s.text, s.startMs])).toEqual([['a', 0], ['b', 1000]]);
    const t2 = normalize('00:00:00,000 --> 00:00:01,000\na\n00:00:01,000 --> 00:00:02,000\nb\n', { provider: 'srt' });
    expect(t2.segments.map((s) => s.text)).toEqual(['a', 'b']);
  });

  it('keeps a number-only body line that is not followed by a time line', () => {
    const t = normalize('00:00:00,000 --> 00:00:01,000\nroom\n101\n', { provider: 'srt' });
    expect(t.text).toBe('room 101');
  });

  it('decodes WebVTT character references in VTT only', () => {
    const body = '00:00:00.000 --> 00:00:01.000\nhello <v Bob>world</v> &amp; you &lt;3 &amp;lt;\n';
    expect(normalize('WEBVTT\n\n' + body, { provider: 'vtt' }).text).toBe('hello world & you <3 &lt;');
    expect(normalize(body.replace(/\./g, ','), { provider: 'srt' }).text).toContain('&amp;');
  });

  it('reports the line number of a bad cue in the error details', () => {
    try {
      normalize('1\n00:00:00,000 --> 00:00:01,000\nok\n\n2\n00:00:0x,000 --> 00:00:02,000\nbad\n', { provider: 'srt' });
      expect.unreachable();
    } catch (e) {
      expect((e as StitchError).code).toBe('UNKNOWN_FORMAT');
      expect((e as StitchError).details.line).toBe(6);
      expect((e as StitchError).message).toContain('line 6');
    }
  });

  it('keeps auto and text string input unchanged', () => {
    for (const opts of [{}, { provider: 'text' as const }]) {
      const t = normalize(SRT, opts);
      expect(t.hasTimestamps).toBe(false);
      expect(t.segments).toEqual([]);
      expect(t.text).toBe(SRT.trim());
    }
  });
});

describe('SRT/VTT input: CLI', () => {
  const c0 = '1\n00:00:00,000 --> 00:00:02,000\none two three four\n\n2\n00:00:02,000 --> 00:00:04,000\nfive six seven eight\n';
  const c1 = '1\n00:00:00,000 --> 00:00:02,000\nfive six seven eight\n\n2\n00:00:02,000 --> 00:00:04,000\nnine ten eleven twelve\n';

  it('stitches two chunk SRT files from a manifest and drops the overlap', () => {
    writeFileSync(join(work, 'c0.srt'), c0);
    writeFileSync(join(work, 'c1.srt'), c1);
    writeFileSync(join(work, 'm.json'), JSON.stringify([{ file: 'c0.srt', startMs: 0 }, { file: 'c1.srt', startMs: 2000 }]));
    const r = cliRun(['stitch', '--manifest', join(work, 'm.json'), '--format', 'txt']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('one two three four five six seven eight nine ten eleven twelve');
  });

  it('recognizes .vtt and an explicit --provider', () => {
    writeFileSync(join(work, 'a.vtt'), 'WEBVTT\n\n00:00.000 --> 00:02.000\nalpha beta\n');
    writeFileSync(join(work, 'mv.json'), JSON.stringify([{ file: 'a.vtt', startMs: 0 }]));
    expect(cliRun(['stitch', '--manifest', join(work, 'mv.json'), '--format', 'txt']).out.trim()).toBe('alpha beta');
    writeFileSync(join(work, 'b.cues'), 'WEBVTT\n\n00:00.000 --> 00:02.000\ngamma\n');
    writeFileSync(join(work, 'mb.json'), JSON.stringify([{ file: 'b.cues', startMs: 0 }]));
    // Only the extension picks the file reader: an unknown extension is read as JSON, even with --provider.
    expect(cliRun(['stitch', '--manifest', join(work, 'mb.json'), '--provider', 'vtt', '--format', 'txt']).code).toBe(2);
  });

  it('reports file path and line for a broken cue file, in en and ko', () => {
    writeFileSync(join(work, 'bad.srt'), '1\n00:00:00,000 --> 00:00:01,000\nok\n\n2\n00:00:0x,000 --> 00:00:02,000\nbad\n');
    writeFileSync(join(work, 'mbad.json'), JSON.stringify([{ file: 'bad.srt', startMs: 0 }]));
    const en = cliRun(['stitch', '--manifest', join(work, 'mbad.json')]);
    expect(en.code).toBe(2);
    expect(en.err).toContain('[BAD_CUE]');
    expect(en.err).toContain(join(work, 'bad.srt'));
    expect(en.err).toContain('line 6');
    expect(en.err).toContain('00:00:0x,000');
    const ko = cliRun(['stitch', '--manifest', join(work, 'mbad.json'), '--lang', 'ko']);
    expect(ko.code).toBe(2);
    expect(ko.err).toContain('[BAD_CUE]');
    expect(ko.err).toContain('6번째 줄');
    expect(ko.err).toContain(join(work, 'bad.srt'));
  });

  it('reads a .vtt file with Kind and Language header lines through the CLI', () => {
    writeFileSync(join(work, 'kind.vtt'), 'WEBVTT\nKind: captions\nLanguage: en\n\n00:00.000 --> 00:02.000\nalpha beta\n');
    writeFileSync(join(work, 'mk.json'), JSON.stringify([{ file: 'kind.vtt', startMs: 0 }]));
    const r = cliRun(['stitch', '--manifest', join(work, 'mk.json'), '--format', 'txt']);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('alpha beta');
  });

  it('shows the supported formats for an unsupported extension, in en and ko', () => {
    writeFileSync(join(work, 'c.xml'), '<not json>');
    writeFileSync(join(work, 'mx.json'), JSON.stringify([{ file: 'c.xml', startMs: 0 }]));
    const en = cliRun(['stitch', '--manifest', join(work, 'mx.json')]);
    expect(en.code).toBe(2);
    expect(en.err).toContain('[UNSUPPORTED_FILE]');
    expect(en.err).toContain('.srt or .vtt');
    const ko = cliRun(['stitch', '--manifest', join(work, 'mx.json'), '--lang', 'ko']);
    expect(ko.err).toContain('[UNSUPPORTED_FILE]');
    expect(ko.err).toContain('.vtt');
    // A broken .json file still reports BAD_JSON.
    writeFileSync(join(work, 'bad.json'), 'nope');
    writeFileSync(join(work, 'mj.json'), JSON.stringify([{ file: 'bad.json', startMs: 0 }]));
    expect(cliRun(['stitch', '--manifest', join(work, 'mj.json')]).err).toContain('[BAD_JSON]');
  });

  it('lists srt and vtt in --help', () => {
    expect(cliRun(['stitch', '--help']).out).toContain('srt or vtt');
  });
});
