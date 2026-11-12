#!/usr/bin/env node
import { run } from './cli/main.js';

// Write synchronously so nothing is lost when the process ends right after.
const code = run(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
});
process.exitCode = code;
