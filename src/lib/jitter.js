/**
 * Timing spread for the automatic check cycle.
 *
 * Two separate jobs, deliberately kept in one place so the numbers are visible together:
 *
 *   nextDelayMinutes()  how long until the next automatic check
 *   actionDelayMs()     how long to wait between two actions inside one check
 *
 * A fixed interval is worse than a jittered one for reasons that have nothing to do with
 * detection: a 10-minute alarm lands on the same second of every tenth minute forever, so
 * every retry after a transient failure lands in the same place too. Spreading the
 * interval decorrelates the checks from each other and from whatever else is on that
 * clock. The inter-action delay exists because the schedule page renders its dropdown
 * before populating it — acting on the DOM the instant it appears is how you select a
 * blank option.
 *
 * `rand` is injectable so the bounds are testable rather than asserted by eye.
 */

/**
 * Floor on the configurable interval. Set to one minute — the shortest delay chrome.alarms
 * reliably honours for a packed extension; anything less is clamped up anyway. Shorter
 * intervals check the portal harder and raise the odds of a block, which is the user's call
 * to make, so this is a technical floor rather than a policy one.
 */
export const MIN_INTERVAL_MINUTES = 1;

/** chrome.alarms rounds anything shorter up anyway; be explicit about the floor. */
export const ALARM_FLOOR_MINUTES = 1;

/** Cap on the consecutive-failure backoff multiplier (2^4 = 16x the base interval). */
export const MAX_BACKOFF_STEPS = 4;

export function clampPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(90, n));
}

/** `base`, plus or minus up to `pct` percent of it. */
export function jitter(base, pct, rand = Math.random) {
  const spread = Math.abs(base) * (clampPct(pct) / 100);
  return base + (rand() * 2 - 1) * spread;
}

/**
 * Delay until the next automatic check.
 *
 * `failures` is the count of consecutive cycles that ended in a block, a challenge or a
 * missing sign-in. Each one doubles the wait. Backing off on refusal is the difference
 * between a loop that notices it is unwelcome and one that keeps knocking.
 */
export function nextDelayMinutes(baseMinutes, pct, failures = 0, rand = Math.random) {
  const base = Math.max(MIN_INTERVAL_MINUTES, Number(baseMinutes) || MIN_INTERVAL_MINUTES);
  const steps = Math.min(MAX_BACKOFF_STEPS, Math.max(0, Math.floor(failures)));
  return Math.max(ALARM_FLOOR_MINUTES, jitter(base * 2 ** steps, pct, rand));
}

/** Milliseconds to wait between two actions within a single check. */
export function actionDelayMs(minMs, maxMs, rand = Math.random) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return Math.round(lo + rand() * (hi - lo));
}
