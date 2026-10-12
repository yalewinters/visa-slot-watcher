import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  extractDates, stripGuard, safeParse, deepParse, describeShape
} from '../src/lib/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('strips the Aura while(1); anti-hijack guard', () => {
  assert.equal(stripGuard('while(1);{"a":1}'), '{"a":1}');
  assert.equal(stripGuard('for(;;);[1]'), '[1]');
  assert.equal(stripGuard(")]}',\n{\"a\":1}"), '{"a":1}');
  assert.equal(stripGuard('{"a":1}'), '{"a":1}');
});

test('safeParse returns null rather than throwing on non-JSON', () => {
  assert.equal(safeParse('<html>nope</html>'), null);
  assert.deepEqual(safeParse('while(1);{"ok":true}'), { ok: true });
});

test('deepParse expands JSON nested inside JSON strings', () => {
  const expanded = deepParse({ returnValue: '{"inner":[1,2]}' });
  assert.deepEqual(expanded.returnValue, { inner: [1, 2] });
});

test('extracts dates, availability, post and times from a real-shaped Aura response', () => {
  const { dates, error } = extractDates(fixture('aura-availability.json'));
  assert.equal(error, null);
  assert.equal(dates.length, 3);

  const first = dates.find((d) => d.date === '2026-09-14');
  assert.ok(first, 'expected 2026-09-14');
  assert.equal(first.available, true);
  assert.equal(first.inferred, false, 'IsAvailable was explicit, not guessed');
  assert.equal(first.post, 'Toronto');
  assert.deepEqual(first.times, ['08:15', '09:00', '10:45']);

  const unavailable = dates.find((d) => d.date === '2026-09-20');
  assert.equal(unavailable.available, false, 'IsAvailable:false must not be reported open');
});

test('a bare array of date strings counts as availability', () => {
  const { dates } = extractDates('{"slots":["2026-10-01","2026-10-02"]}');
  assert.deepEqual(dates.map((d) => d.date), ['2026-10-01', '2026-10-02']);
  assert.ok(dates.every((d) => d.available && d.inferred));
});

test('an empty calendar is reported as empty, not as a failure', () => {
  // The common case: nothing open. This must not look like a parse error, or every
  // normal check would read as broken.
  const { dates, error, empty, suspect } =
    extractDates('{"actions":[{"state":"SUCCESS","returnValue":{"AvailableDates":[]}}]}');
  assert.equal(dates.length, 0);
  assert.equal(error, null);
  assert.equal(empty, true);
  assert.equal(suspect, false);
});

test('dates in the body that we failed to match are flagged as suspect', () => {
  // Schema drift: the body clearly holds a date, but under a key we do not match.
  const { dates, empty, suspect } = extractDates('{"blob":{"zz":"2026-09-14"}}');
  assert.equal(dates.length, 0);
  assert.equal(empty, false);
  assert.equal(suspect, true, 'unmatched dates must be surfaced, not silently ignored');
});

test('non-JSON input is reported, not thrown', () => {
  const { dates, error } = extractDates(fixture('blocked.html'));
  assert.equal(dates.length, 0);
  assert.match(error, /not JSON/);
});

test('describeShape reveals real field names when extraction misses them', () => {
  // The diagnostic that matters: an unfamiliar schema must be inspectable, since the
  // portal's response format is undocumented and can change under us.
  const weird = 'while(1);{"actions":[{"returnValue":' +
    '{"returnValue":"{\\"slotData\\":[{\\"xd\\":\\"2026-09-14\\",\\"loc\\":\\"Toronto\\"}]}"}}]}';
  const lines = describeShape(weird, 20);
  assert.ok(lines.some((l) => l.includes('slotData')), 'nested field names are surfaced');
  assert.ok(lines.some((l) => l.includes('"2026-09-14"')), 'the date value is visible');
  assert.ok(lines.every((l) => l.startsWith('$')), 'every line is a JSON path');
});

test('describeShape reports plainly when the body is not JSON', () => {
  assert.deepEqual(describeShape('<html>blocked</html>'), ['<not JSON>']);
});

test('ISO datetimes are reduced to their date part and deduplicated', () => {
  const { dates } = extractDates(
    '{"a":{"appointmentDate":"2026-09-14T08:15:00Z"},"b":{"appointmentDate":"2026-09-14"}}');
  assert.equal(dates.length, 1);
  assert.equal(dates[0].date, '2026-09-14');
});
