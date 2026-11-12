/** Error codes thrown by the library. The CLI maps each code to a localized message. */
export type StitchErrorCode =
  | 'BAD_INPUT'
  | 'UNKNOWN_FORMAT'
  | 'NON_MONOTONIC'
  | 'NO_TIMESTAMPS'
  | 'PLAN_IMPOSSIBLE'
  | 'BAD_WAV';

/** Error with a stable `code`. The message is English and meant for developers. */
export class StitchError extends Error {
  readonly code: StitchErrorCode;
  /** Small machine-readable context (for example the chunk index). */
  readonly details: Readonly<Record<string, string | number>>;

  constructor(code: StitchErrorCode, message: string, details: Record<string, string | number> = {}) {
    super(message);
    this.name = 'StitchError';
    this.code = code;
    this.details = details;
  }
}
