import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  StitchError,
  detectSilences,
  parseDuration,
  parseSize,
  planChunks,
  readWavSamples,
  stitch,
  toSrt,
  toText,
  toVtt,
} from '../index.js';
import type { ChunkInput, PlannedChunk, Provider } from '../index.js';
import { CliError, parseArgv, type ArgSpec } from './args.js';
import { runDemo } from './demo.js';
import { isLang, resolveLang, t, type Env, type Lang } from './i18n.js';
import type { MessageKey } from './messages/en.js';
import { reportText, warningLine } from './report.js';
import { renderTable } from './table.js';

export const VERSION = '0.1.0';

export interface CliContext {
  env: Env;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

const COMMANDS = ['demo', 'stitch', 'plan'] as const;
type Command = (typeof COMMANDS)[number];

const GLOBAL_FLAGS = ['help', 'version'];
const SPECS: Record<Command, ArgSpec> = {
  demo: { values: ['lang', 'out-dir'], flags: GLOBAL_FLAGS, short: { h: 'help' } },
  stitch: {
    values: ['lang', 'manifest', 'provider', 'format', 'output'],
    flags: [...GLOBAL_FLAGS, 'report', 'strict'],
    short: { o: 'output', h: 'help' },
  },
  plan: {
    values: ['lang', 'max-size', 'max-duration', 'overlap', 'min-chunk'],
    flags: [...GLOBAL_FLAGS, 'ffmpeg', 'json'],
    short: { h: 'help' },
  },
};
const TOP_SPEC: ArgSpec = { values: ['lang'], flags: GLOBAL_FLAGS, short: { h: 'help', v: 'version' } };

const PROVIDERS: Provider[] = ['auto', 'openai', 'groq', 'whispercpp', 'text'];
const FORMATS = ['srt', 'vtt', 'txt', 'json'] as const;

/** Find `--lang` before the command is known, so errors are shown in the right language. */
function scanLangFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--lang') return argv[i + 1];
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

function fileError(path: string, e: unknown): CliError {
  const errno = (e as NodeJS.ErrnoException).code;
  if (errno === 'ENOENT') return new CliError('FILE_NOT_FOUND', { path });
  return new CliError('FILE_ERROR', { path, reason: errno ?? 'EIO' });
}

function readFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (e) {
    throw fileError(path, e);
  }
}

function readJsonFile(path: string): unknown {
  const text = readFile(path).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('BAD_JSON', { path });
  }
}

function writeFile(path: string, data: string): void {
  try {
    writeFileSync(path, data);
  } catch (e) {
    throw fileError(path, e);
  }
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], option: string, fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new CliError('USAGE_BAD_VALUE', { option, value });
  return value as T;
}

function readManifest(path: string): ChunkInput[] {
  const raw = readJsonFile(path);
  const list = Array.isArray(raw) ? raw : (raw as { chunks?: unknown } | null)?.chunks;
  if (!Array.isArray(list) || list.length === 0) throw new CliError('BAD_MANIFEST', { index: 0 });
  const base = dirname(path);
  return list.map((entry: unknown, index: number): ChunkInput => {
    const e = entry as { file?: unknown; startMs?: unknown; endMs?: unknown; overlapMs?: unknown } | null;
    if (!e || typeof e.file !== 'string' || typeof e.startMs !== 'number' || !Number.isFinite(e.startMs)) {
      throw new CliError('BAD_MANIFEST', { index });
    }
    const file = resolve(base, e.file);
    const result = file.toLowerCase().endsWith('.txt') ? readFile(file).toString('utf8') : readJsonFile(file);
    const input: ChunkInput = { startMs: e.startMs, result };
    if (typeof e.endMs === 'number') input.endMs = e.endMs;
    if (typeof e.overlapMs === 'number') input.overlapMs = e.overlapMs;
    return input;
  });
}

function runStitch(argv: string[], ctx: CliContext, lang: Lang): number {
  const p = parseArgv(argv, SPECS.stitch);
  if (p.flags.has('help')) {
    ctx.out(t(lang, 'help.stitch') + '\n');
    return 0;
  }
  const manifestPath = p.values.manifest;
  if (manifestPath === undefined) throw new CliError('USAGE_MISSING_ARG', { name: '--manifest' });
  const provider = pick(p.values.provider, PROVIDERS, '--provider', 'auto');
  const format = pick(p.values.format, FORMATS, '--format', 'srt');

  const chunks = readManifest(resolve(ctx.cwd, manifestPath));
  const result = stitch(
    chunks.map((c) => (provider === 'auto' ? c : { ...c, provider })),
  );

  let body: string;
  if (format === 'srt') body = toSrt(result);
  else if (format === 'vtt') body = toVtt(result);
  else if (format === 'txt') body = toText(result) + '\n';
  else body = JSON.stringify({ text: result.text, hasTimestamps: result.hasTimestamps, segments: result.segments, words: result.words, report: result.report }, null, 2) + '\n';

  if (p.values.output !== undefined) writeFile(resolve(ctx.cwd, p.values.output), body);
  else ctx.out(body);

  if (p.flags.has('report')) ctx.err(reportText(lang, result.report) + '\n');
  else for (const w of result.report.warnings) ctx.err('! ' + warningLine(lang, w) + '\n');

  if (p.flags.has('strict') && result.report.warnings.length > 0) {
    ctx.err(t(lang, 'strict.failed', { count: result.report.warnings.length }) + '\n');
    return 1;
  }
  return 0;
}

function optionValue(value: string | undefined, option: string, parse: (v: string) => number): number | undefined {
  if (value === undefined) return undefined;
  try {
    return parse(value);
  } catch {
    throw new CliError('USAGE_BAD_VALUE', { option, value });
  }
}

function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const rest = String(ms % 1000).padStart(3, '0');
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${rest}`;
}

function runPlan(argv: string[], ctx: CliContext, lang: Lang): number {
  const p = parseArgv(argv, SPECS.plan);
  if (p.flags.has('help')) {
    ctx.out(t(lang, 'help.plan') + '\n');
    return 0;
  }
  const file = p.positional[0];
  if (file === undefined) throw new CliError('USAGE_MISSING_ARG', { name: '<file.wav>' });
  if (p.values['max-size'] === undefined) throw new CliError('USAGE_MISSING_ARG', { name: '--max-size' });
  const maxBytes = optionValue(p.values['max-size'], '--max-size', parseSize) as number;
  const maxDurationMs = optionValue(p.values['max-duration'], '--max-duration', parseDuration);
  const overlapMs = optionValue(p.values.overlap, '--overlap', parseDuration);
  const minChunkMs = optionValue(p.values['min-chunk'], '--min-chunk', parseDuration);

  const path = resolve(ctx.cwd, file);
  const { info, samples } = readWavSamples(new Uint8Array(readFile(path)));
  const bytesPerSecond = (info.sampleRate * info.channels * info.bitsPerSample) / 8;
  const silences = detectSilences(samples, info.sampleRate);
  const chunks: PlannedChunk[] = planChunks({
    durationMs: info.durationMs,
    bytesPerSecond,
    maxBytes,
    ...(maxDurationMs === undefined ? {} : { maxDurationMs }),
    ...(overlapMs === undefined ? {} : { overlapMs }),
    ...(minChunkMs === undefined ? {} : { minChunkMs }),
    silences,
  });

  if (p.flags.has('json')) {
    ctx.out(JSON.stringify({ file: basename(path), durationMs: info.durationMs, bytesPerSecond, silences, chunks }, null, 2) + '\n');
    return 0;
  }
  if (p.flags.has('ffmpeg')) {
    const stem = basename(path).replace(/\.[^.]+$/, '');
    for (const c of chunks) {
      const name = `${stem}-chunk-${String(c.index).padStart(3, '0')}.wav`;
      ctx.out(`ffmpeg -ss ${seconds(c.startMs)} -t ${seconds(c.endMs - c.startMs)} -i ${shellQuote(file)} -c copy ${shellQuote(name)}\n`);
    }
    return 0;
  }
  ctx.out(
    t(lang, 'plan.summary', {
      file: basename(path),
      duration: clock(info.durationMs),
      rate: bytesPerSecond,
      count: chunks.length,
      silences: silences.length,
    }) + '\n\n',
  );
  const rows = chunks.map((c) => [
    String(c.index),
    clock(c.startMs),
    clock(c.endMs),
    String(c.estBytes),
    t(lang, c.forceSplit ? 'plan.cut.forced' : c.cutInSilence ? 'plan.cut.silence' : 'plan.cut.none'),
  ]);
  ctx.out(renderTable([t(lang, 'plan.index'), t(lang, 'plan.start'), t(lang, 'plan.end'), t(lang, 'plan.size'), t(lang, 'plan.cut')], rows, ['r', 'l', 'l', 'r', 'l']) + '\n');
  return 0;
}

function runDemoCommand(argv: string[], ctx: CliContext, lang: Lang): number {
  const p = parseArgv(argv, SPECS.demo);
  if (p.flags.has('help')) {
    ctx.out(t(lang, 'help.demo') + '\n');
    return 0;
  }
  const outDir = resolve(ctx.cwd, p.values['out-dir'] ?? 'out');
  try {
    runDemo(lang, outDir, (line) => ctx.out(line + '\n'), p.values['out-dir'] ?? 'out');
  } catch (e) {
    if (e instanceof CliError || e instanceof StitchError) throw e;
    throw fileError(join(outDir), e);
  }
  return 0;
}

function exitCodeFor(e: unknown): number {
  if (e instanceof CliError) return e.exitCode;
  if (e instanceof StitchError) return e.code === 'PLAN_IMPOSSIBLE' ? 3 : 2;
  return 2;
}

function describe(e: unknown, lang: Lang): { code: string; message: string; usage: boolean } {
  if (e instanceof CliError) {
    return { code: e.code, message: t(lang, e.messageKey, e.vars), usage: e.code.startsWith('USAGE_') || e.code === 'BAD_LANG' };
  }
  if (e instanceof StitchError) {
    const vars: Record<string, string | number> = { ...e.details };
    return { code: e.code, message: t(lang, `error.${e.code}` as MessageKey, vars), usage: false };
  }
  return { code: 'UNEXPECTED', message: t(lang, 'error.UNEXPECTED'), usage: false };
}

/**
 * Run the CLI. Returns the exit code: 0 ok, 1 warnings with --strict,
 * 2 usage or input error, 3 no plan possible.
 */
export function run(argv: string[], ctx: CliContext): number {
  const flagValue = scanLangFlag(argv);
  // Errors before the language is known are shown in the environment language.
  let lang: Lang = resolveLang(undefined, ctx.env);
  try {
    if (flagValue !== undefined) {
      if (!isLang(flagValue)) throw new CliError('BAD_LANG', { value: flagValue });
      lang = resolveLang(flagValue, ctx.env);
    }
    const first = argv.find((a, i) => !a.startsWith('-') && argv[i - 1] !== '--lang');
    if (first === undefined) {
      const top = parseArgv(argv, TOP_SPEC);
      if (top.flags.has('version')) {
        ctx.out(VERSION + '\n');
        return 0;
      }
      ctx.out(t(lang, 'help.main') + '\n');
      return top.flags.has('help') ? 0 : 2;
    }
    if (!(COMMANDS as readonly string[]).includes(first)) throw new CliError('USAGE_UNKNOWN_COMMAND', { command: first });
    const command = first as Command;
    const index = argv.indexOf(first);
    const rest = argv.filter((_, i) => i !== index);
    if (rest.includes('--version') || rest.includes('-v')) {
      ctx.out(VERSION + '\n');
      return 0;
    }
    if (command === 'demo') return runDemoCommand(rest, ctx, lang);
    if (command === 'stitch') return runStitch(rest, ctx, lang);
    return runPlan(rest, ctx, lang);
  } catch (e) {
    const d = describe(e, lang);
    ctx.err(`${t(lang, 'error.label')} [${d.code}]: ${d.message}\n`);
    if (d.usage) ctx.err(t(lang, 'error.hint') + '\n');
    return exitCodeFor(e);
  }
}
