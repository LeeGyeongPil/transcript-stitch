import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages, resolveLang, t } from '../src/cli/i18n.js';
import { en } from '../src/cli/messages/en.js';
import { ko } from '../src/cli/messages/ko.js';
import { VERSION, run } from '../src/cli/main.js';
import { displayWidth, renderTable } from '../src/cli/table.js';

const root = join(import.meta.dirname, '..');
const cli = join(root, 'dist', 'cli.js');

function runCli(args: string[], env: Record<string, string> = {}): { code: number; out: string; err: string } {
  const outs: string[] = [];
  const errs: string[] = [];
  const code = run(args, { env, cwd: root, out: (s) => outs.push(s), err: (s) => errs.push(s) });
  return { code, out: outs.join(''), err: errs.join('') };
}

describe('AC-9: language choice order', () => {
  it('--lang beats TRANSCRIPT_STITCH_LANG beats LC_ALL / LC_MESSAGES / LANG', () => {
    expect(resolveLang('ko', { TRANSCRIPT_STITCH_LANG: 'en', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveLang('en', { TRANSCRIPT_STITCH_LANG: 'ko', LANG: 'ko_KR.UTF-8' })).toBe('en');
    expect(resolveLang(undefined, { TRANSCRIPT_STITCH_LANG: 'ko', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveLang(undefined, { TRANSCRIPT_STITCH_LANG: 'en', LC_ALL: 'ko_KR.UTF-8' })).toBe('en');
    expect(resolveLang(undefined, { LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'en_US', LANG: 'en_US' })).toBe('ko');
    expect(resolveLang(undefined, { LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ko');
    expect(resolveLang(undefined, { LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(resolveLang(undefined, { LANG: 'ko' })).toBe('ko');
  });

  it('anything that is not Korean means English', () => {
    expect(resolveLang(undefined, {})).toBe('en');
    expect(resolveLang(undefined, { LANG: 'C' })).toBe('en');
    expect(resolveLang(undefined, { LANG: 'ja_JP.UTF-8' })).toBe('en');
    expect(resolveLang(undefined, { LANG: 'korean_Foo' })).toBe('en');
    // an empty LC_ALL does not hide LANG; an invalid TRANSCRIPT_STITCH_LANG is ignored
    expect(resolveLang(undefined, { LC_ALL: '', LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(resolveLang(undefined, { TRANSCRIPT_STITCH_LANG: 'fr', LANG: 'ko_KR.UTF-8' })).toBe('ko');
    expect(resolveLang(undefined, { TRANSCRIPT_STITCH_LANG: 'KO' })).toBe('ko');
  });

  it('the English and Korean tables have exactly the same keys', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(messages.ko)).toHaveLength(Object.keys(messages.en).length);
  });

  it('every {placeholder} appears in both languages', () => {
    const names = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(names(ko[key]), key).toEqual(names(en[key]));
    }
  });

  it('t fills placeholders and keeps unknown ones visible', () => {
    expect(t('en', 'demo.truth', { words: 28 })).toBe('truth: 28 words');
    expect(t('ko', 'demo.truth', { words: 28 })).toBe('정답: 28단어');
    expect(t('en', 'error.FILE_NOT_FOUND')).toContain('{path}');
  });

  it('the Korean screen has no leftover English sentences', () => {
    const allowed = new Set([
      'transcript-stitch', 'demo', 'stitch', 'plan', 'manifest', 'ffmpeg', 'mock', 'input', 'output', 'mp3', 'wav', 'pcm_s16le',
      'verbose_json', 'openai', 'groq', 'whispercpp', 'whisper', 'cpp', 'auto', 'text', 'txt', 'json', 'srt', 'vtt', 'file', 'startms', 'endms',
      'chunk', 'chunks', 'en', 'ko', 'lang', 'help', 'version', 'out', 'dir', 'ms', 'api', 'lc', 'all', 'messages', 'transcript', 'stitch_lang', 'strict',
      'verbose', 'pcm', 's16le', 'max', 'size', 'duration', 'overlap', 'min', 'report', 'format', 'provider', 'naive', 'stitched', 'mb', 'mib', 'bat', 'tmp', 'foo',
    ]);
    const bad: string[] = [];
    for (const [key, value] of Object.entries(ko)) {
      if (key === 'error.label' && /[a-z]/i.test(value)) bad.push(key);
      const words = value.replace(/\{\w+\}/g, ' ').match(/[A-Za-z_][A-Za-z_.0-9-]*/g) ?? [];
      for (const w of words) {
        // option names, codes (UPPER_CASE) and file names are not sentences
        if (/^[A-Z_0-9]+$/.test(w)) continue;
        for (const part of w.toLowerCase().split(/[-_.]/)) {
          if (part.length > 1 && !/^\d+$/.test(part) && !allowed.has(part)) bad.push(`${key}: ${w}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('AC-9: screens follow the language', () => {
  it('English and Korean help differ and carry the right words', () => {
    const enHelp = runCli(['--help', '--lang', 'en'], { LANG: 'ko_KR.UTF-8' });
    const koHelp = runCli(['--help', '--lang', 'ko'], { LANG: 'en_US.UTF-8' });
    expect(enHelp.code).toBe(0);
    expect(koHelp.code).toBe(0);
    expect(enHelp.out).toContain('Usage');
    expect(enHelp.out).not.toContain('사용법');
    expect(koHelp.out).toContain('사용법');
    expect(koHelp.out).not.toContain('Usage');
  });

  it('every command help follows --lang', () => {
    for (const command of ['demo', 'stitch', 'plan']) {
      expect(runCli([command, '--help', '--lang', 'ko']).out).toContain('사용법');
      expect(runCli([command, '--help', '--lang', 'en']).out).toContain('Usage');
      expect(runCli([command, '-h'], { TRANSCRIPT_STITCH_LANG: 'ko' }).out).toContain('사용법');
    }
  });

  it('the environment picks the language when there is no flag', () => {
    expect(runCli(['--help'], { TRANSCRIPT_STITCH_LANG: 'ko', LANG: 'en_US.UTF-8' }).out).toContain('사용법');
    expect(runCli(['--help'], { LANG: 'ko_KR.UTF-8' }).out).toContain('사용법');
    expect(runCli(['--help'], { LANG: 'en_US.UTF-8' }).out).toContain('Usage');
    expect(runCli(['--help'], {}).out).toContain('Usage');
  });

  it('errors are shown in the chosen language only', () => {
    const koErr = runCli(['stitch', '--manifest', 'no-such.json', '--lang', 'ko']);
    expect(koErr.code).toBe(2);
    expect(koErr.err).toContain('오류 [FILE_NOT_FOUND]');
    expect(koErr.err).not.toMatch(/\b(error|not found|file)\b/i);
    const enErr = runCli(['stitch', '--manifest', 'no-such.json', '--lang', 'en']);
    expect(enErr.err).toContain('error [FILE_NOT_FOUND]: File not found');
    expect(runCli(['stitch', '--bogus', '--lang', 'ko']).err).toContain('알 수 없는 옵션');
    expect(runCli(['frobnicate', '--lang', 'ko']).err).toContain('알 수 없는 명령');
    expect(runCli(['--lang', 'fr', '--help']).code).toBe(2);
    expect(runCli(['--lang', 'fr'], { LANG: 'ko_KR.UTF-8' }).err).toContain('알 수 없는 언어');
  });

  it('demo output is English or Korean, never mixed', () => {
    const out = join(process.env.TMPDIR ?? '/tmp', 'ts-i18n-demo');
    const enRun = runCli(['demo', '--lang', 'en', '--out-dir', out]);
    const koRun = runCli(['demo', '--lang', 'ko', '--out-dir', out]);
    expect(enRun.out).toContain('naive: 37 words (9 duplicated)');
    expect(enRun.out).toContain('stitched: 28 words, 0 duplicated, max drift 0 ms');
    expect(enRun.out).not.toMatch(/[가-힣]/);
    expect(koRun.out).toContain('단순 이어 붙이기: 37단어 (중복 9단어)');
    expect(koRun.out).toContain('stitch 결과: 28단어, 중복 0단어, 최대 시각 오차 0 ms');
    expect(koRun.out).toContain('연습용 목(mock) 모드');
    expect(enRun.out).toContain('Practice mock mode');
    expect(koRun.out).not.toContain('Boundary report');
  });

  it('the built CLI binary honours --lang and the environment', () => {
    const koHelp = spawnSync('node', [cli, '--help', '--lang', 'ko'], { encoding: 'utf8', env: { ...process.env, LANG: 'en_US.UTF-8', TRANSCRIPT_STITCH_LANG: '' } });
    expect(koHelp.status).toBe(0);
    expect(koHelp.stdout).toContain('사용법');
    const enHelp = spawnSync('node', [cli, '--help', '--lang', 'en'], { encoding: 'utf8' });
    expect(enHelp.stdout).toContain('Usage');
    const envKo = spawnSync('node', [cli, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TRANSCRIPT_STITCH_LANG: 'ko' } });
    expect(envKo.stdout).toContain('사용법');
  });

  it('prints the version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(runCli(['--version']).out.trim()).toBe(VERSION);
    expect(runCli(['-v']).out.trim()).toBe(VERSION);
  });
});

describe('tables align by display width', () => {
  it('counts Korean characters as two columns', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('단어')).toBe(4);
    expect(displayWidth('a단b')).toBe(4);
    expect(displayWidth('')).toBe(0);
  });

  it('every line of a Korean table has the same display width', () => {
    const table = renderTable(['앞 조각', '방식', '겹침 (ms)'], [['0', '단어 정렬', '1500'], ['12', '맞닿음', '0']], ['r', 'l', 'r']);
    const widths = table.split('\n').map(displayWidth);
    expect(new Set(widths).size).toBe(1);
  });

  it('the report table in the demo lines up in both languages', () => {
    const out = join(process.env.TMPDIR ?? '/tmp', 'ts-i18n-table');
    for (const lang of ['en', 'ko']) {
      const text = runCli(['demo', '--lang', lang, '--out-dir', out]).out.split('\n');
      const start = text.findIndex((l) => l.startsWith('---'));
      const block = text.slice(start - 1, start + 3);
      expect(block.length).toBe(4);
      expect(new Set(block.map(displayWidth)).size).toBe(1);
    }
  });
});
