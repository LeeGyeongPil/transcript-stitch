/** Which response shape a chunk result has. `auto` detects it. */
export type Provider = 'auto' | 'openai' | 'groq' | 'whispercpp' | 'text';

/** One word. All times are integer milliseconds. */
export interface Word {
  text: string;
  startMs: number;
  endMs: number;
  /** Index of the chunk this word came from. */
  chunk: number;
  probability?: number;
  /** True when the time was interpolated from a segment (the response had no word times). */
  estimated?: boolean;
}

export interface Segment {
  text: string;
  startMs: number;
  endMs: number;
  chunk: number;
  words?: Word[];
}

/** Common format. For one chunk the times are relative to the chunk; after `stitch` they are absolute. */
export interface Transcript {
  text: string;
  segments: Segment[];
  words?: Word[];
  hasTimestamps: boolean;
}

export interface ChunkInput {
  /** Where the chunk starts in the original audio (ms, rounded to an integer). */
  startMs: number;
  /** Where the chunk ends in the original audio. Optional; defaults to the last word end. */
  endMs?: number;
  /** The raw API response for this chunk. */
  result: unknown;
  provider?: Provider;
  /** The overlap the splitter reported. Only recorded in the report, never trusted. */
  overlapMs?: number;
}

export interface StitchOptions {
  /** Minimum matching words to trust an alignment (default 2). */
  minMatchWords?: number;
  /** Extra time around the overlap used to collect candidate words (default 500). */
  windowSlackMs?: number;
  /** Two words only match when their start times differ at most this much (default 300). */
  maxWordDriftMs?: number;
  /** What to do when the overlap has no matching words (default `midpoint`). */
  onNoMatch?: 'midpoint' | 'keep-both';
  /**
   * Also match overlapped words that differ slightly (spelling, plural).
   * `false` or unset: exact match only (default). `true`: Jaro-Winkler
   * similarity of at least 0.85. A number: that similarity threshold, greater
   * than 0 and at most 1. Words with fewer than 3 letters or digits are
   * always compared exactly. Repeated phrases can be aligned wrongly, so it
   * is off by default.
   */
  fuzzy?: boolean | number;
}

export type WarningCode =
  | 'NO_MATCH'
  | 'GAP'
  | 'EMPTY_CHUNK'
  | 'UNKNOWN_END'
  | 'REPORTED_OVERLAP_DIFFERS'
  | 'MIXED_TIMESTAMPS';

export interface StitchWarning {
  code: WarningCode;
  /** English text for logs. */
  message: string;
  /** Boundary index (0 = between chunk 0 and 1), when the warning belongs to one. */
  boundary?: number;
  /** Values for localized messages. */
  data: Record<string, number | string>;
}

export interface BoundaryReport {
  left: number;
  right: number;
  /** Overlap computed from the chunk boundary times (never negative). */
  actualOverlapMs: number;
  /** Overlap the splitter claimed, when the input carried one. */
  reportedOverlapMs?: number;
  method: 'words' | 'text' | 'midpoint' | 'adjacent';
  matchedWords: number;
  droppedLeft: number;
  droppedRight: number;
  warnings: StitchWarning[];
}

export interface StitchReport {
  boundaries: BoundaryReport[];
  warnings: StitchWarning[];
}

export interface Stitched extends Transcript {
  report: StitchReport;
}

export interface SubtitleOptions {
  /** Maximum characters per cue line (default 42). */
  maxChars?: number;
  /** Maximum cue length in ms (default 7000). */
  maxCueMs?: number;
}

export interface TextOptions {
  /** Start a new paragraph when the pause between segments is at least this long (default 2000). */
  paragraphGapMs?: number;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface PlanOptions {
  durationMs: number;
  bytesPerSecond: number;
  /** A number of bytes or a string such as `25mb` (decimal) or `24mib`. */
  maxBytes: number | string;
  /** Container header bytes added to every chunk (default 44, a WAV header). */
  headerBytes?: number;
  /** Fraction of `maxBytes` actually used (default 0.98). */
  safetyRatio?: number;
  maxDurationMs?: number;
  /** Shortest allowed chunk, except the last (default 10000). */
  minChunkMs?: number;
  /** Audio shared between neighbouring chunks (default 0). */
  overlapMs?: number;
  /** Silent ranges. Cuts are placed inside them when possible. */
  silences?: TimeRange[];
}

export interface PlannedChunk {
  index: number;
  startMs: number;
  endMs: number;
  estBytes: number;
  /** The cut that ends this chunk lies inside a silence. False for the last chunk. */
  cutInSilence: boolean;
  /** The cut that ends this chunk had to be placed without a silence. */
  forceSplit: boolean;
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

export interface SilenceOptions {
  /** Frames quieter than this are silent (default -40 dBFS). */
  thresholdDb?: number;
  /** Shortest silence to report (default 400). */
  minSilenceMs?: number;
  /** Analysis frame length (default 20). */
  frameMs?: number;
}
