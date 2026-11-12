// Checks the package shape before publishing. Run: npm run check:package
//  - no runtime dependencies
//  - npm pack would include the built entry points
//  - the core sources (everything in src/ except the CLI) do not import node: modules,
//    so the library also runs in browsers, Deno and Bun
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const depCount = Object.keys(pkg.dependencies ?? {}).length;
console.log('dependencies: ' + depCount);
if (depCount !== 0) problems.push('package.json must have no runtime dependencies');

let packed;
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  packed = JSON.parse(out)[0].files.map((f) => f.path);
} catch (e) {
  problems.push('npm pack --dry-run failed: ' + (e instanceof Error ? e.message : String(e)));
  packed = [];
}
for (const needed of ['dist/index.js', 'dist/index.d.ts', 'dist/cli.js']) {
  if (!packed.includes(needed)) problems.push(needed + ' is missing from the package (run npm run build first)');
}
console.log('packed files: ' + packed.length);

function listTs(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...listTs(path));
    else if (name.endsWith('.ts')) files.push(path);
  }
  return files;
}
const src = join(root, 'src');
for (const file of listTs(src)) {
  const rel = relative(src, file);
  if (rel === 'cli.ts' || rel.startsWith('cli/') || rel.startsWith('cli\\')) continue;
  if (/from\s+['"]node:|require\(\s*['"]node:|import\(\s*['"]node:/.test(readFileSync(file, 'utf8'))) {
    problems.push('src/' + rel + ' imports a node: module; the core must stay runtime-neutral');
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error('problem: ' + p);
  process.exit(1);
}
console.log('ok');
