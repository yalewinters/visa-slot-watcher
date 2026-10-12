import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jitter, clampPct, nextDelayMinutes, actionDelayMs,
  MIN_INTERVAL_MINUTES, ALARM_FLOOR_MINUTES, MAX_BACKOFF_STEPS
} from '../src/lib/jitter.js';

/** Math.random() returns [0,1); these are the two ends and the middle. */
const LOW = () => 0;
const MID = () => 0.5;
const HIGH = () => 0.999999;

test('jitter spans exactly plus and minus the given percentage', () => {
  assert.equal(jitter(10, 30, MID), 10);
  assert.equal(jitter(10, 30, LOW), 7);
  assert.ok(Math.abs(jitter(10, 30, HIGH) - 13) < 0.001);
});

test('zero percent is a fixed interval, which stays available', () => {
  for (const rand of [LOW, MID, HIGH]) assert.equal(jitter(10, 0, rand), 10);
});

test('percentages are clamped, so a typo cannot produce a negative interval', () => {
  assert.equal(clampPct(-40), 0);
  assert.equal(clampPct(500), 90);
  assert.equal(clampPct('abc'), 0);
  assert.ok(jitter(10, 500, LOW) > 0);
});

test('an interval below the floor is raised to it, not honoured', () => {
  // The point of the floor is that it cannot be talked out of by the settings page.
  assert.equal(nextDelayMinutes(1, 0, 0, MID), MIN_INTERVAL_MINUTES);
  assert.equal(nextDelayMinutes(0, 0, 0, MID), MIN_INTERVAL_MINUTES);
  assert.equal(nextDelayMinutes('', 0, 0, MID), MIN_INTERVAL_MINUTES);
});

test('every alarm is at least the alarm floor, even at full negative jitter', () => {
  assert.ok(nextDelayMinutes(MIN_INTERVAL_MINUTES, 90, 0, LOW) >= ALARM_FLOOR_MINUTES);
});

test('consecutive failures double the wait', () => {
  assert.equal(nextDelayMinutes(10, 0, 0, MID), 10);
  assert.equal(nextDelayMinutes(10, 0, 1, MID), 20);
  assert.equal(nextDelayMinutes(10, 0, 3, MID), 80);
});

test('backoff stops doubling at the cap instead of running away', () => {
  const capped = nextDelayMinutes(10, 0, MAX_BACKOFF_STEPS, MID);
  assert.equal(capped, 10 * 2 ** MAX_BACKOFF_STEPS);
  assert.equal(nextDelayMinutes(10, 0, 99, MID), capped);
});

test('action delays stay inside their bounds and are whole milliseconds', () => {
  assert.equal(actionDelayMs(700, 2200, LOW), 700);
  assert.equal(actionDelayMs(700, 2200, HIGH), 2200);
  const drawn = actionDelayMs(700, 2200);
  assert.ok(drawn >= 700 && drawn <= 2200);
  assert.equal(drawn, Math.round(drawn));
});

test('an inverted range does not produce a delay below its minimum', () => {
  assert.equal(actionDelayMs(2200, 700, HIGH), 2200);
});
