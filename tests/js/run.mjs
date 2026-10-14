// Runs every browser-module harness in this directory and exits non-zero if any fail.
// The front-end modules are dependency-free by design, so they can be exercised in Node
// with small fakes for fetch / <audio> / DOM — no browser and no build step.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

let failed = 0;
for (const file of files) {
  process.stdout.write(`\n──── ${file} ${'─'.repeat(Math.max(0, 56 - file.length))}\n`);
  try {
    process.stdout.write(execFileSync(process.execPath, [join(here, file)], { encoding: 'utf8' }));
  } catch (err) {
    failed += 1;
    process.stdout.write(String(err.stdout || '') + String(err.stderr || ''));
    process.stdout.write(`FAILED: ${file}\n`);
  }
}
console.log(`\n${files.length - failed}/${files.length} harnesses green`);
process.exit(failed === 0 ? 0 : 1);
