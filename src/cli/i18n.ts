import { en, type MessageKey } from './messages/en.js';
import { ko } from './messages/ko.js';

export type Lang = 'en' | 'ko';

export const LANGS: readonly Lang[] = ['en', 'ko'];

export const messages: Record<Lang, Record<MessageKey, string>> = { en, ko };

export type Env = Record<string, string | undefined>;

function asLang(value: string | undefined): Lang | undefined {
  const v = value?.trim().toLowerCase();
  return v === 'en' || v === 'ko' ? v : undefined;
}

/** `ko`, `ko_KR.UTF-8`, `ko-KR` -> Korean. Anything else -> English. */
function fromLocale(env: Env): Lang {
  // The first locale variable that is set decides, as in POSIX.
  const raw = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v !== undefined && v !== '');
  return raw !== undefined && /^ko([_.@-]|$)/i.test(raw.trim()) ? 'ko' : 'en';
}

/**
 * Pick the screen language: the `--lang` flag, then TRANSCRIPT_STITCH_LANG,
 * then LC_ALL, LC_MESSAGES and LANG. Not Korean means English.
 * An invalid flag value is the caller's job to reject; here it is ignored.
 */
export function resolveLang(flag: string | undefined, env: Env): Lang {
  return asLang(flag) ?? asLang(env.TRANSCRIPT_STITCH_LANG) ?? fromLocale(env);
}

export function isLang(value: string): value is Lang {
  return asLang(value) !== undefined;
}

/** Look up a message and fill in `{name}` values. Unknown keys return the key itself. */
export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = messages[lang][key];
  if (template === undefined) return key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
