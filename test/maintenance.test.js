import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Lift the real pattern out of the content script rather than copying it.
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'quickcheck-content.js'), 'utf8');
const MAINT_RE = new Function(
  'return ' + source.match(/const MAINT_RE = (\/.*\/[a-z]*);/)[1]
)();

test("the portal's maintenance page is recognised by its title", () => {
  assert.ok(MAINT_RE.test('Website under maintenance'));
  assert.ok(MAINT_RE.test('U.S. Visa Scheduling Scheduled Website Outage. Thank You.'));
});

test('ordinary portal pages are not read as maintenance', () => {
  for (const text of [
    'Schedule Appointment', 'Just a moment...', 'Sign in', 'Security Questions',
    'Please select a consular post', 'Website downtime notices are posted on the home page'
  ]) {
    assert.ok(!MAINT_RE.test(text), text);
  }
});
