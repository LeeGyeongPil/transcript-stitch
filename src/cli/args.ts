import type { MessageKey } from './messages/en.js';

/** An error the CLI shows in the chosen language. `code` selects the `error.<code>` message. */
export class CliError extends Error {
  readonly code: string;
  readonly vars: Record<string, string | number>;
  readonly exitCode: number;

  constructor(code: string, vars: Record<string, string | number> = {}, exitCode = 2) {
    super(code);
    this.name = 'CliError';
    this.code = code;
    this.vars = vars;
    this.exitCode = exitCode;
  }

  get messageKey(): MessageKey {
    return `error.${this.code}` as MessageKey;
  }
}

export interface ArgSpec {
  /** Options that take a value, without the dashes. */
  values: string[];
  /** Options without a value. */
  flags: string[];
  /** Short names, for example `{ o: 'output' }`. */
  short?: Record<string, string>;
}

export interface Parsed {
  values: Record<string, string>;
  flags: Set<string>;
  positional: string[];
}

/** A small argument parser: `--name value`, `--name=value`, `-o value`, flags and positionals. */
export function parseArgv(argv: string[], spec: ArgSpec): Parsed {
  const parsed: Parsed = { values: {}, flags: new Set(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      parsed.positional.push(...argv.slice(i + 1));
      break;
    }
    const isLong = arg.startsWith('--');
    const isShort = !isLong && /^-[a-zA-Z]$/.test(arg);
    if (!isLong && !isShort) {
      parsed.positional.push(arg);
      continue;
    }
    let name = isLong ? arg.slice(2) : (spec.short?.[arg.slice(1)] ?? arg.slice(1));
    let inline: string | undefined;
    const eq = name.indexOf('=');
    if (isLong && eq >= 0) {
      inline = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    if (spec.flags.includes(name)) {
      parsed.flags.add(name);
    } else if (spec.values.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new CliError('USAGE_MISSING_VALUE', { option: arg.split('=')[0]! });
      }
      parsed.values[name] = value;
    } else {
      throw new CliError('USAGE_UNKNOWN_OPTION', { option: arg.split('=')[0]! });
    }
  }
  return parsed;
}
