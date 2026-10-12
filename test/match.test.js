import test from 'node:test';
import assert from 'node:assert/strict';

import {
  filterMatches, diffNew, resolveRange, monthsInRange, addMonths, todayISO
} from '../src/lib/match.js';

const NOW = new Date('2026-08-25T12:00:00Z');

const settings = (over = {}) => ({
  enabled: true, intervalMinutes: 10, rangeStart: '', rangeEnd: '',
  ...over
});

const slot = (date, over = {}) =>
  ({ date, available: true, inferred: false, post: 'Toronto', times: [], ...over });

test('range defaults to today through six months out', () => {
  const range = resolveRange(settings(), NOW);
  assert.equal(range.start, todayISO(NOW));
  assert.equal(range.end, addMonths(todayISO(NOW), 6));
});

test('a start date in the past is clamped to today', () => {
  const range = resolveRange(settings({ rangeStart: '2020-01-01' }), NOW);
  assert.equal(range.start, todayISO(NOW), 'never offers a date that has already passed');
});

test('months in range are enumerated inclusively', () => {
  const months = monthsInRange({ start: '2026-11-10', end: '2027-02-03' });
  assert.deepEqual(months, [
    { year: 2026, month: 11 }, { year: 2026, month: 12 },
    { year: 2027, month: 1 }, { year: 2027, month: 2 }
  ]);
});

test('filters out unavailable dates and dates outside the window', () => {
  const dates = [
    slot('2026-09-14'),
    slot('2026-09-20', { available: false }),
    slot('2027-06-01')
  ];
  const matches = filterMatches(dates, settings({ rangeEnd: '2026-12-31' }), NOW);
  assert.deepEqual(matches.map((m) => m.date), ['2026-09-14']);
});

test('every post is accepted', () => {
  const dates = [slot('2026-09-14', { post: 'Anywhere' })];
  assert.equal(filterMatches(dates, settings(), NOW).length, 1);
});

test('a slot notifies once, not on every tick', () => {
  const matches = [slot('2026-09-14')];
  const first = diffNew(matches, {}, NOW);
  assert.equal(first.fresh.length, 1);

  const second = diffNew(matches, first.seen, NOW);
  assert.equal(second.fresh.length, 0, 'same slot must not re-notify');

  const third = diffNew([...matches, slot('2026-09-18')], second.seen, NOW);
  assert.deepEqual(third.fresh.map((m) => m.date), ['2026-09-18']);
});

test('the seen set drops dates that have passed', () => {
  const stale = { 'Toronto|2020-01-01': 1, 'Toronto|2026-09-14': 1 };
  const { seen } = diffNew([], stale, NOW);
  assert.deepEqual(Object.keys(seen), ['Toronto|2026-09-14']);
});

test('the same date at different posts is tracked separately', () => {
  const first = diffNew([slot('2026-09-14', { post: 'Toronto' })], {}, NOW);
  const second = diffNew([slot('2026-09-14', { post: 'Vancouver' })], first.seen, NOW);
  assert.equal(second.fresh.length, 1);
});
