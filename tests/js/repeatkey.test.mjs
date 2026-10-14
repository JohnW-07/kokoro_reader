// JS half of the repeated-line key contract. See tests/test_repeat_key_contract.py.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { normaliseRepeatKey } from '../../static/js/pdfview.js';

const fixture = new URL('../fixtures/repeat_keys.json', import.meta.url);
const { cases } = JSON.parse(readFileSync(fixture, 'utf8'));

let passed = 0;
for (const [raw, expected] of cases) {
  assert.equal(normaliseRepeatKey(raw), expected,
    `normaliseRepeatKey(${JSON.stringify(raw)}) must equal ${JSON.stringify(expected)}`);
  passed += 1;
  console.log(`  ok  ${JSON.stringify(raw)} -> ${JSON.stringify(expected)}`);
}
console.log(`\nALL PASS: ${passed} passed, 0 failed`);
