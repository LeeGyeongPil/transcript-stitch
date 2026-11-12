# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-13

### Added
- `normalize` for OpenAI and Groq `verbose_json`, whisper.cpp `verbose_json` (sub-word tokens grouped into words) and text-only responses, with integer millisecond times.
- `stitch` and `naiveConcat`: chunk offset correction, overlap computed from chunk boundary times, de-duplication by longest common run of words, whole words preferred over cut-off pieces, midpoint fallback, text-only alignment, and a per-boundary `report` with warnings.
- `toSrt`, `toVtt` and `toText` with continuous cue numbers, non-overlapping cues and line and cue length limits.
- `planChunks` for size, duration and minimum-length limits with silence-aware cuts, `readWavInfo`, `readWavSamples` and `detectSilences`.
- `transcript-stitch` CLI with `demo`, `stitch` and `plan` commands, English and Korean screens (`--lang`, `TRANSCRIPT_STITCH_LANG`, `LANG`) and tables aligned by display width.
- Practice (mock) fixtures and a deterministic generator script.

### Known issues
- Piping CLI output into a program that closes early (for example `transcript-stitch demo | head -2`) ends with an unhandled `EPIPE` error trace instead of exiting quietly. Output written before that is complete; redirect to a file as a workaround.
