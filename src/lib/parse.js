/**
 * Pulls appointment dates out of an Aura response.
 *
 * Deliberately schema-agnostic: the portal's response shape isn't publicly documented
 * and changes with Salesforce releases, so this walks whatever JSON comes back looking
 * for date-shaped values and nearby availability/location hints rather than reaching
 * for fixed field names.
 */

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;
const DATE_KEY = /(^|[_.\- ])(date|day|dt)([_.\- ]|$)|appointmentdate|slotdate|availabledate/i;
const AVAIL_KEY = /(availab|isopen|hasslot|openslot|isbookable|bookable|isfree)/i;
const POST_KEY = /(post|location|facility|consulate|embassy|city|site|center|centre|territory|office)/i;
const TIMES_KEY = /^(times|availabletimes|slots|timeslots|availableslots|appointmenttimes)$/i;
const MAX_DEPTH = 40;

/** Aura prefixes responses with while(1); to blunt JSON hijacking. */
export function stripGuard(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/^\s*(?:while\s*\(1\)\s*;|for\s*\(;;\)\s*;|\)\]\}',?)\s*/, '');
}

export function safeParse(text) {
  if (typeof text !== 'string') return text;
  try {
    return JSON.parse(stripGuard(text));
  } catch {
    return null;
  }
}

/**
 * Aura nests JSON inside JSON: action returnValues routinely arrive as strings that
 * themselves need parsing. Expand those in place so one walk sees everything.
 */
export function deepParse(node, depth = 0) {
  if (depth > MAX_DEPTH) return node;

  if (typeof node === 'string') {
    const trimmed = node.trim();
    if (trimmed.length > 1 && (trimmed[0] === '{' || trimmed[0] === '[')) {
      const inner = safeParse(trimmed);
      if (inner !== null && typeof inner === 'object') return deepParse(inner, depth + 1);
    }
    return node;
  }

  if (Array.isArray(node)) return node.map((v) => deepParse(v, depth + 1));

  if (node && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) out[key] = deepParse(node[key], depth + 1);
    return out;
  }

  return node;
}

const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function truthy(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return /^(true|yes|y|1|available|open)$/i.test(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return null;
}

/**
 * Note the three distinct zero-date outcomes. A fully-booked calendar legitimately
 * returns no dates, and reporting that as a failure would make the normal case look
 * broken — so it is only a `suspect` parse when the raw body *does* contain date-like
 * strings that the field matching failed to pick up.
 *
 * @returns {{
 *   dates: Array<{date,available,inferred,post,times,path}>,
 *   error: string|null,   unreadable response
 *   empty: boolean,       read fine, genuinely nothing open
 *   suspect: boolean      dates present in the body but not matched — schema drift
 * }}
 */
export function extractDates(raw) {
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw) || '';
  const hasRawDates = /\d{4}-\d{2}-\d{2}/.test(rawText);

  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (parsed === null || typeof parsed !== 'object') {
    return { dates: [], error: 'response was not JSON', empty: false, suspect: false };
  }

  const expanded = deepParse(parsed);
  const found = new Map();

  const record = (entry) => {
    const key = `${entry.post || ''}|${entry.date}`;
    const prior = found.get(key);
    if (!prior) {
      found.set(key, entry);
      return;
    }
    // An explicit availability flag always beats an inferred one.
    if (prior.inferred && !entry.inferred) found.set(key, entry);
    else if (entry.times.length > prior.times.length) prior.times = entry.times;
  };

  const walk = (node, ctx, path, depth) => {
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach((item, i) => {
        // A bare array of date strings is itself an availability list.
        if (typeof item === 'string') {
          const m = ISO_DATE.exec(item.trim());
          if (m) {
            record({
              date: m[1], available: true, inferred: true,
              post: ctx.post, times: [], path: `${path}[${i}]`
            });
          }
          return;
        }
        walk(item, ctx, `${path}[${i}]`, depth + 1);
      });
      return;
    }

    const keys = Object.keys(node);
    const childCtx = { ...ctx };

    for (const key of keys) {
      const value = node[key];
      if (typeof value === 'string' && value.trim() && POST_KEY.test(normKey(key)) &&
          !ISO_DATE.test(value.trim()) && value.length < 120) {
        childCtx.post = value.trim();
      }
    }

    let availability = null;
    for (const key of keys) {
      if (!AVAIL_KEY.test(normKey(key))) continue;
      const t = truthy(node[key]);
      if (t !== null) { availability = t; break; }
    }

    let times = [];
    for (const key of keys) {
      if (!TIMES_KEY.test(normKey(key))) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        times = value.filter((v) => typeof v === 'string').slice(0, 60);
        if (times.length && availability === null) availability = true;
      }
    }

    for (const key of keys) {
      const value = node[key];
      if (typeof value !== 'string') continue;
      const m = ISO_DATE.exec(value.trim());
      if (!m) continue;
      if (!DATE_KEY.test(normKey(key))) continue;
      record({
        date: m[1],
        available: availability === null ? true : availability,
        inferred: availability === null,
        post: childCtx.post,
        times,
        path: `${path}.${key}`
      });
    }

    for (const key of keys) {
      walk(node[key], childCtx, `${path}.${key}`, depth + 1);
    }
  };

  walk(expanded, {}, '$', 0);

  const dates = [...found.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || String(a.post).localeCompare(String(b.post)));

  const none = dates.length === 0;
  return {
    dates,
    error: null,
    empty: none && !hasRawDates,
    suspect: none && hasRawDates
  };
}

/** Compact structural summary, for eyeballing an unfamiliar payload in the popup. */
export function describeShape(raw, limit = 60) {
  const parsed = typeof raw === 'string' ? safeParse(raw) : raw;
  if (parsed === null || typeof parsed !== 'object') return ['<not JSON>'];

  const expanded = deepParse(parsed);
  const lines = [];

  const walk = (node, path, depth) => {
    if (lines.length >= limit || depth > 12) return;
    if (Array.isArray(node)) {
      lines.push(`${path}  [${node.length}]`);
      if (node.length) walk(node[0], `${path}[0]`, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (lines.length >= limit) return;
        walk(node[key], `${path}.${key}`, depth + 1);
      }
      return;
    }
    const preview = typeof node === 'string' ? `"${node.slice(0, 40)}"` : String(node);
    lines.push(`${path} = ${preview}`);
  };

  walk(expanded, '$', 0);
  return lines;
}
