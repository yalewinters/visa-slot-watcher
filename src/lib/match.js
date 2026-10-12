/** Date-range / post filtering, and the seen-set diff that stops repeat notifications. */

export const todayISO = (now = new Date()) => {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + n, d));
  return date.toISOString().slice(0, 10);
}

/** Effective window: today..+6 months unless the user narrowed it. */
export function resolveRange(settings, now = new Date()) {
  const today = todayISO(now);
  const start = settings.rangeStart && settings.rangeStart > today ? settings.rangeStart : today;
  const end = settings.rangeEnd || addMonths(today, 6);
  return { start, end };
}

/** Months the poller needs to cover, visited one per tick. */
export function monthsInRange(range) {
  const months = [];
  let [y, m] = range.start.split('-').map(Number);
  const [ey, em] = range.end.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    months.push({ year: y, month: m });
    if (++m > 12) { m = 1; y++; }
    if (months.length >= 24) break;
  }
  return months.length ? months : [{
    year: Number(range.start.slice(0, 4)),
    month: Number(range.start.slice(5, 7))
  }];
}

export function filterMatches(dates, settings, now = new Date()) {
  const { start, end } = resolveRange(settings, now);
  return dates.filter((d) => d.available && d.date >= start && d.date <= end);
}

export const seenKey = (m) => `${m.post || 'any'}|${m.date}`;

/**
 * Returns matches not yet reported, plus a pruned seen-set.
 * Pruning drops past dates so the map can't grow without bound.
 */
export function diffNew(matches, seen, now = new Date()) {
  const today = todayISO(now);
  const nextSeen = {};
  for (const [key, when] of Object.entries(seen || {})) {
    const date = key.split('|')[1];
    if (date && date >= today) nextSeen[key] = when;
  }

  const fresh = [];
  for (const match of matches) {
    const key = seenKey(match);
    if (!(key in nextSeen)) fresh.push(match);
    nextSeen[key] = Date.now();
  }
  return { fresh, seen: nextSeen };
}
