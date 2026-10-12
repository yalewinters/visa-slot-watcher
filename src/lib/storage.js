/** Typed wrappers over chrome.storage, with defaults in one place. */

export const DEFAULT_SETTINGS = {
  enabled: true,
  rangeStart: '',        // 'YYYY-MM-DD'; empty = no lower bound beyond today
  rangeEnd: '',          // 'YYYY-MM-DD'; empty = 6 months out
  ntfyTopic: '',         // ntfy.sh topic name; when set, key events are pushed there for your phone

  // Automatic checking. Off unless you turn it on: it opens the schedule page on a timer
  // without you, which is a materially different thing from reading what you browse.
  autoCheck: false,
  autoCheckMinutes: 10,     // base interval; floored at MIN_INTERVAL_MINUTES
  autoCheckJitterPct: 30,   // +/- this much of the base, per cycle
  steadyInterval: true,     // true = always the set interval; false = double it after each refused/failed cycle
  autoCheckFocus: false,    // false = drive the tab in the background, don't steal focus
  autoCheckWhileActive: true, // false = skip a cycle rather than reload the portal tab you're on
  refreshOnChallenge: true, // reload the page once when a verification challenge appears; you still clear it
  preferredPost: '',     // consular post to select, e.g. "GUANGZHOU"; blank = the first one listed
  waitMinutes: 10,          // longest wait in the site queue or a rate limit before the check is rerun
  autoBook: false           // book the earliest in-range slot automatically — irreversible; off unless you turn it on
};

export const DEFAULT_STATE = {
  status: 'idle',        // idle | ok | error | challenge | blocked
  detail: '',
  lastSeenAt: 0,
  lastMatches: [],
  lastAvailable: [],     // every open day seen, in or out of range — popup reference
  lastResponse: null,
  lastShape: null,
  autoFailures: 0,       // consecutive refused/failed automatic cycles; drives backoff
  lastAutoAt: 0,
  checkStartedAt: 0,     // when the extension last started a check; results outside one are ignored
  checkDoneAt: 0,        // when that check ended (result or failure); the watchdog reads it
  resultReportedFor: 0,  // checkStartedAt of the check whose result was last pushed
  waitSince: 0,          // when the current queue / rate-limit wait began
  nextAutoAt: 0
};

const local = chrome.storage.local;

async function read(area, key, fallback) {
  const got = await area.get(key);
  const value = got[key];
  if (value === undefined || value === null) return structuredClone(fallback);
  return (fallback && typeof fallback === 'object' && !Array.isArray(fallback))
    ? { ...structuredClone(fallback), ...value }
    : value;
}

export const getSettings = () => read(local, 'settings', DEFAULT_SETTINGS);
export const setSettings = (settings) => local.set({ settings });

export const getState = () => read(local, 'state', DEFAULT_STATE);
export const setState = async (patch) => {
  const state = { ...(await getState()), ...patch };
  await local.set({ state });
  return state;
};

/** Dates already reported, so a slot isn't announced every time you open the page. */
export const getSeen = () => read(local, 'seen', {});
export const setSeen = (seen) => local.set({ seen });

/**
 * Portal sign-in credentials, used only by automatic checking.
 *
 * `answers` is a list of { q, a } pairs for the portal's security questions — it asks one
 * after the password on a device it doesn't recognise, and there is no way to know in
 * advance which one, so every question you might be asked has to be saved for unattended
 * sign-in to get past that step.
 *
 * All of it sits unencrypted in the extension's local storage — chrome.storage.local is a
 * plain file in the browser profile, and nothing here can make it otherwise. Anything
 * that can read the profile directory can read this password and these answers. Security
 * answers are worth a second thought on that point: the same ones usually unlock the rest
 * of someone's accounts. That is the cost of unattended sign-in; the options page says so
 * before you type any of it in, and clearing the fields deletes it.
 */
export const getCreds = () =>
  read(local, 'creds', { email: '', password: '', answers: [] });

export const setCreds = (creds) => {
  const worth = creds && (creds.password || (creds.answers || []).length);
  return worth ? local.set({ creds }) : local.remove('creds');
};
