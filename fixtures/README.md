# Fixtures (practice mock data)

These files are **practice (mock) responses, not recordings of a real API.**
`scripts/make-fixtures.mjs` starts from a known sentence (one word every 400 ms, each word 350 ms long),
cuts it into overlapping chunks like an audio splitter would, converts the times to chunk-relative seconds,
and damages the chunk edges the way real responses are damaged. The output is deterministic: run `npm run fixtures`
and the same files come out.

| Folder | Truth | Chunks | What it exercises |
|---|---|---|---|
| `probe28/` | 28 words | 3, overlaps 1.5 s | `openai/`, `whispercpp/` (sub-word tokens) and `text/` (no timestamps) versions of the same chunks. Naive concatenation gives 37 words (9 duplicated). |
| `lecture/` | 330 words | 6, overlaps 3 s / 0 / 1.5 s / 0 / 1.5 s | Repeated phrases ("we measure, we log", "very important") inside the overlaps, `openai/` and `whispercpp/` versions. |
| `ko-text/` | 36 words | 3, overlaps 1.5 s | Korean text-only responses (no timestamps). |

Damage added to the chunk edges:

- the last word of a chunk that ends in the middle of a word becomes a piece (`upload` becomes `upl`);
- the first word of a chunk that starts in the middle of a sentence gets a capital letter and a comma;
- a word that starts before the chunk start gets the start time 0.

Each folder has a `truth.json` with the sentence and the true word times, and one `manifest.json` per format
(`chunks[]` with `file`, `startMs`, `endMs`, and the `overlapMs` the splitter would report).

The sentences were written for this project and are released under the MIT license, like the rest of the repository.
