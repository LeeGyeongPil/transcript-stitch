// Builds the practice (mock) fixtures. Run: npm run fixtures
//
// These are NOT recordings. Each fixture starts from a known sentence with one
// word every 400 ms (word 350 ms long), cuts it into overlapping chunks like a
// splitter would, converts the times to chunk-relative seconds and then damages
// the chunk edges the way real responses are damaged:
//   - the last word of a chunk that was cut in the middle of a word becomes a piece ("upl")
//   - the first word of a chunk gets a capital letter and a comma
//   - a word that starts before the chunk start gets a start time of 0
// The output is deterministic (no randomness, no clock).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Lay words on a timeline: `pitch` ms between word starts, `dur` ms per word, extra pause after sentence ends. */
function timeline(sentences, { pitch, dur, pause }) {
  const words = [];
  let t = 0;
  for (const sentence of sentences) {
    const parts = sentence.split(' ');
    parts.forEach((text, i) => {
      words.push({ text, startMs: t, endMs: t + dur });
      t += pitch;
      if (i === parts.length - 1) t += pause;
    });
  }
  return words;
}

/** Words of one chunk, with chunk-relative times and edge damage. */
function sliceChunk(words, startMs, endMs, first) {
  const picked = words.filter((w) => w.endMs > startMs && w.startMs < endMs).map((w) => ({ ...w }));
  const out = picked.map((w, i) => {
    let text = w.text;
    const chars = Array.from(text);
    const straddlesEnd = i === picked.length - 1 && w.startMs < endMs && w.endMs > endMs;
    if (straddlesEnd) {
      const keep = Math.max(2, Math.floor((chars.length * (endMs - w.startMs)) / (w.endMs - w.startMs)));
      text = chars.slice(0, Math.min(keep, chars.length - 1)).join('');
    }
    if (i === 0 && !first) text = text.charAt(0).toUpperCase() + text.slice(1).replace(/[.,!?]$/u, '') + ',';
    return { text, startMs: Math.max(0, w.startMs - startMs), endMs: w.endMs - startMs };
  });
  return out;
}

const sec = (ms) => Math.round(ms) / 1000;

function openaiResponse(words, durationMs) {
  const text = words.map((w) => w.text).join(' ');
  return {
    task: 'transcribe',
    language: 'english',
    duration: sec(durationMs),
    text,
    words: words.map((w) => ({ word: w.text, start: sec(w.startMs), end: sec(w.endMs) })),
    segments: [{ id: 0, seek: 0, start: sec(words[0].startMs), end: sec(words[words.length - 1].endMs), text }],
  };
}

function whispercppTokens(w) {
  const m = /^(.+?)([,.!?])$/u.exec(w.text);
  const body = m ? m[1] : w.text;
  const punct = m ? m[2] : '';
  const chars = Array.from(body);
  const tokens = [];
  if (chars.length >= 6) {
    const cut = Math.ceil(chars.length / 2);
    const mid = w.startMs + Math.round((w.endMs - w.startMs) / 20) * 10;
    tokens.push({ word: ' ' + chars.slice(0, cut).join(''), start: sec(w.startMs), end: sec(mid), t_dtw: -1, probability: 0.9 });
    tokens.push({ word: chars.slice(cut).join(''), start: sec(mid), end: sec(w.endMs), t_dtw: -1, probability: 0.95 });
  } else {
    tokens.push({ word: ' ' + body, start: sec(w.startMs), end: sec(w.endMs), t_dtw: -1, probability: 0.92 });
  }
  if (punct) tokens.push({ word: punct, start: sec(w.endMs), end: sec(w.endMs), t_dtw: -1, probability: 0.8 });
  return tokens;
}

function whispercppResponse(words, durationMs) {
  const text = ' ' + words.map((w) => w.text).join(' ');
  const tokens = [{ word: '[_BEG_]', start: sec(words[0].startMs), end: sec(words[0].startMs), t_dtw: -1, probability: 1 }];
  for (const w of words) tokens.push(...whispercppTokens(w));
  return {
    task: 'transcribe',
    language: 'en',
    duration: sec(durationMs),
    text,
    segments: [{ id: 0, start: sec(words[0].startMs), end: sec(words[words.length - 1].endMs), text, words: tokens }],
  };
}

/**
 * cuts: [{ startMs, endMs }] chunk boundaries on the original timeline.
 * formats: which response shapes to write.
 */
function writeFixture(name, truthWords, cuts, formats) {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  writeJson(join(dir, 'truth.json'), {
    note: 'Practice mock data: the known sentence the chunk responses were synthesized from.',
    text: truthWords.map((w) => w.text).join(' '),
    words: truthWords,
  });
  for (const format of formats) {
    const manifest = { chunks: [] };
    cuts.forEach((cut, i) => {
      const words = sliceChunk(truthWords, cut.startMs, cut.endMs, i === 0 || cuts[i - 1].endMs <= cut.startMs);
      const durationMs = cut.endMs - cut.startMs;
      const file = `chunk-${i}.json`;
      let body;
      if (format === 'openai') body = openaiResponse(words, durationMs);
      else if (format === 'whispercpp') body = whispercppResponse(words, durationMs);
      else body = { text: words.map((w) => w.text).join(' ') };
      writeJson(join(dir, format, file), body);
      const entry = { file, startMs: cut.startMs, endMs: cut.endMs };
      if (i > 0) entry.overlapMs = cuts[i - 1].endMs - cut.startMs;
      manifest.chunks.push(entry);
    });
    writeJson(join(dir, format, 'manifest.json'), manifest);
  }
}

// ---- probe28: 28 words, three chunks, 1.5 s overlaps ----
const probeSentence = 'long recordings must be split before upload each chunk is transcribed on its own then the pieces are stitched back together without duplicates or gaps at every boundary';
const probeWords = timeline([probeSentence], { pitch: 400, dur: 350, pause: 0 });
const probeEnd = probeWords[probeWords.length - 1].endMs + 100;
writeFixture(
  'probe28',
  probeWords,
  [
    { startMs: 0, endMs: 2600 },
    { startMs: 1100, endMs: 7200 },
    { startMs: 5700, endMs: probeEnd },
  ],
  ['openai', 'whispercpp', 'text'],
);

// ---- lecture: about 300 words, six chunks, overlaps 0 / 1.5 s / 3 s, repeated phrases ----
const lectureSentences = [
  'Welcome back to the workshop.',
  'Today we are building a small weather station for the roof.',
  'First we need a sensor that reads the temperature every ten seconds.',
  'The sensor is cheap, so we will buy two and compare them.',
  'We measure, we log, we measure, we log, and then we compare the numbers.',
  'If the numbers disagree by more than a degree, one sensor is wrong.',
  'Next comes the wind gauge, which is just a spinning cup on a short pole.',
  'Every turn of the cup closes a switch and the board counts the turns.',
  'More turns per minute means more wind, and we turn that into meters per second.',
  'Keep the pole away from the chimney, because warm air from the chimney spoils the readings.',
  'Now let us talk about power.',
  'A small solar panel and one battery can run the whole station for weeks.',
  'On cloudy days the battery carries the load, and on sunny days the panel fills it again.',
  'Check the battery voltage once a day for the first week.',
  'Very important, very important, never mount the board without a plastic cover.',
  'Rain finds every gap, so seal the cable hole with soft rubber.',
  'The board sends one message every five minutes to the home network.',
  'Each message holds the temperature, the wind speed and the battery level.',
  'On the receiving side a tiny program stores every message in a plain text file.',
  'A plain text file is easy to read, easy to copy and easy to back up.',
  'After a month we draw a chart of the temperature for every single day.',
  'The chart shows warm afternoons, cool nights and one very windy weekend.',
  'Then we compare the chart with the forecast from the local weather service.',
  'Sometimes the forecast wins and sometimes our small station wins.',
  'We measure, we log, we measure, we log, and that habit is the whole project.',
  'Thank you for following along, and see you in the next workshop.',
];
const lectureWords = timeline(lectureSentences, { pitch: 400, dur: 350, pause: 600 });
const lectureEnd = lectureWords[lectureWords.length - 1].endMs + 200;

/** Midpoint of the pause after the sentence that contains word index `k` (a cut that splits no word). */
function pauseAfter(k) {
  let i = k;
  while (!/[.!?]$/u.test(lectureWords[i].text)) i++;
  return lectureWords[i].endMs + 300 + 50 - 50; // inside the 650 ms gap before the next sentence
}
const wordTime = (index) => lectureWords[index].startMs + 100;
const firstIndexOf = (text, from = 0) => lectureWords.findIndex((w, i) => i >= from && w.text === text);
const repeatA = firstIndexOf('measure,');
const veryImportant = firstIndexOf('Very');

// cut points (end of each chunk) and the overlap that follows each of them
const lectureCutSpec = [
  { at: wordTime(repeatA + 4), overlap: 3000 },
  { at: pauseAfter(firstIndexOf('Now') - 1), overlap: 0 },
  { at: wordTime(veryImportant + 3), overlap: 1500 },
  { at: pauseAfter(firstIndexOf('After') - 1), overlap: 0 },
  { at: wordTime(firstIndexOf('Then') + 3), overlap: 1500 },
];
const lectureCuts = [];
let from = 0;
for (const spec of lectureCutSpec) {
  lectureCuts.push({ startMs: from, endMs: spec.at });
  from = spec.at - spec.overlap;
}
lectureCuts.push({ startMs: from, endMs: lectureEnd });
writeFixture('lecture', lectureWords, lectureCuts, ['openai', 'whispercpp']);

// ---- ko-text: Korean text-only responses (no timestamps), three chunks ----
const koSentences = [
  '긴 녹음은 음성 인식 서비스에 보내기 전에 여러 조각으로 나누어야 합니다.',
  '각 조각은 따로 받아쓰기를 한 다음 하나로 다시 이어 붙입니다.',
  '이때 겹친 부분의 단어가 두 번 나오지 않도록 주의해야 합니다.',
  '마지막으로 자막 파일을 만들어 확인합니다.',
];
const koWords = timeline(koSentences, { pitch: 500, dur: 450, pause: 0 });
const koEnd = koWords[koWords.length - 1].endMs + 200;
writeFixture(
  'ko-text',
  koWords,
  [
    { startMs: 0, endMs: 7000 },
    { startMs: 5500, endMs: 13000 },
    { startMs: 11500, endMs: koEnd },
  ],
  ['text'],
);

console.log('fixtures written to ' + root);
