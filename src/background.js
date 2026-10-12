/**
 * Service worker.
 *
 * Two modes, and the difference between them matters:
 *
 *   Passive   — the extension issues no requests at all. It reads the availability data
 *               the portal returns while you browse the calendar yourself. Nothing
 *               contacts the site unless you click.
 *
 *   Automatic — a jittered alarm opens the schedule page in a real tab on your behalf,
 *               signs in if the portal signed you out, selects your post, and reads the
 *               result. Off by default. This does access the portal without you, which
 *               the portal's terms prohibit; the settings page says so plainly.
 *
 * Automatic mode drives the real page in a real tab. That is deliberate, and it is the
 * only version of this that works. An earlier design replayed the calendar request from
 * the worker on a timer and Cloudflare blocked it, because a fetch from a service worker
 * carries no Origin or Referer and reports Sec-Fetch-Site: none. Dressing that request up
 * to look like page traffic would be circumventing the block — so no request is forged
 * here. The page makes its own requests, because the page is what gets driven.
 *
 * Refusal is respected rather than retried: a block or a challenge ends the cycle without
 * touching the site and backs the next one off exponentially (see lib/jitter.js).
 */

import {
  getSettings, setSettings, getState, setState as saveState, getSeen, setSeen
} from './lib/storage.js';
import { nextDelayMinutes } from './lib/jitter.js';
import { extractDates, describeShape } from './lib/parse.js';
import {
  triage, describeResponse, CHALLENGE, BLOCKED, QUEUED, RATE_LIMITED
} from './lib/triage.js';
import { filterMatches, diffNew } from './lib/match.js';

/*
 * What counts as "a portal tab".
 *
 * The second entry is the identity provider: this portal signs in through Azure AD B2C,
 * so a tab sitting mid-sign-in is on atlasauth.b2clogin.com and belongs to the same check.
 * Leaving it out meant a check in progress looked like no tab at all — the next cycle
 * would open a second one beside it, and a sign-in page you were typing into was not
 * recognised as a page you were using.
 *
 * Scoped to the one tenant deliberately. `*.b2clogin.com` would be every organisation's
 * sign-in page on Microsoft's shared domain, which is not a permission this needs.
 */
const PORTAL_GLOBS = [
  'https://*.usvisascheduling.com/*',
  'https://atlasauth.b2clogin.com/*'
];
const PORTAL_HOST =
  /^https:\/\/(([a-z0-9-]+\.)*usvisascheduling\.com|atlasauth\.b2clogin\.com)\//i;
// The portal is a single-page app that boots from the site root. Deep-linking straight
// to /en-US/schedule/ does not reliably come up, so every entry point is the root and the
// check clicks through to the calendar using the app's own navigation.
const PORTAL_URL = 'https://www.usvisascheduling.com/';
const AUTO_ALARM = 'vsw-autocheck';
const RETRY_ALARM = 'vsw-retry';   // ends a queue / rate-limit wait that ran too long
const WATCHDOG_ALARM = 'vsw-watchdog'; // notices a check that never finished
const CHECK_TIMEOUT_MIN = 5;

const waitLimitMs = (settings) =>
  Math.min(120, Math.max(1, Number(settings.waitMinutes) || 10)) * 60000;

/*
 * How long after the extension starts a check a calendar response still belongs to it.
 * Anything outside this window is you browsing the portal yourself, which is ignored:
 * only checks the extension runs are read. Generous, since a check may sit out a full
 * queue or rate-limit wait before the calendar loads.
 */
const checkWindowMs = (settings) => waitLimitMs(settings) + 15 * 60000;

const BADGE = { ok: '#1e8e3e', warn: '#f9ab00', stop: '#d93025', idle: '#5f6368' };

async function badge(text, color) {
  try {
    await chrome.action.setBadgeText({ text: String(text) });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* action can be briefly unavailable during startup */ }
}

/* ---------------------------------------------------------- notifications */

/* ----------------------------------------------------------- activity log */

const LOG_KEY = 'activityLog';
const LOG_MAX = 1000;
let logChain = Promise.resolve();

/**
 * Appends one line to the activity log (the 操作记录 page).
 *
 * Writes are chained: handlers run interleaved, and two read-modify-writes racing on the
 * same key would silently drop a line. `source` is 'ext' for the worker and 'page' for
 * the progress banners the check shows on the portal itself.
 */
function logEvent(level, text, source = 'ext') {
  if (!text) return logChain;
  logChain = logChain.then(async () => {
    const got = await chrome.storage.local.get(LOG_KEY);
    const log = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
    log.push({ at: Date.now(), level, source, text: String(text).slice(0, 600) });
    await chrome.storage.local.set({ [LOG_KEY]: log.slice(-LOG_MAX) });
  }).catch(() => {});
  return logChain;
}

const LEVEL_BY_STATUS = {
  ok: 'ok', error: 'warn', challenge: 'warn', queued: 'warn', ratelimited: 'warn', blocked: 'error'
};

/**
 * setState, plus a log line whenever the status detail is set. That detail is the
 * one-line account of what just happened that the popup shows, so logging it here covers
 * every state change without a separate call at each site.
 */
async function setState(patch, level) {
  const next = await saveState(patch);
  if (patch.detail) logEvent(level || LEVEL_BY_STATUS[next.status] || 'info', patch.detail);
  return next;
}

const clock = (ms) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });

/* ---------------------------------------------------------- notifications */

function notifyPlain(title, message) {
  logEvent('info', '桌面通知：' + title);
  chrome.notifications.create('info|' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icon128.png'),
    title,
    message: String(message || '').slice(0, 300),
    priority: 2,
    silent: true
  }, () => void chrome.runtime.lastError);
}

/**
 * Pushes one progress line to your phone through ntfy.sh, if you have set a topic.
 *
 * Fire-and-forget and best-effort: the phone feed is a convenience, never something a check
 * depends on, so it is never awaited on the critical path and every failure is swallowed.
 * It is published as JSON rather than through headers, so the title can be Chinese — a
 * header-borne title has to be ASCII. It only ever sends what the popup already shows — never an address,
 * password or security answer, none of which the extension records in the first place.
 */
async function notifyPhone(title, message, { priority = 3, tags = '', click = '' } = {}) {
  // One outer guard: this is called fire-and-forget from the critical path, so it must
  // never reject (an unhandled rejection) and never throw — a missing phone feed is fine.
  try {
    const { ntfyTopic } = await getSettings();
    const raw = (ntfyTopic || '').trim();
    if (!raw) return;

    const topic = raw.replace(/^https?:\/\/ntfy\.sh\//i, '').replace(/^\/+/, '');
    if (!topic) return;

    const body = { topic, message: String(message || '').slice(0, 1000), priority };
    if (title) body.title = String(title).slice(0, 120);
    if (tags) body.tags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    // ntfy opens this URL when the notification is tapped, and also shows it as a button.
    if (click) {
      body.click = click;
      body.actions = [{ action: 'view', label: '打开预约网站', url: click }];
    }

    const res = await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    logEvent(res.ok ? 'info' : 'warn', res.ok
      ? '已推送到手机：' + (title || '')
      : '手机推送失败（HTTP ' + res.status + '）：' + (title || ''));
  } catch {
    // the phone feed must never break or delay a check
    logEvent('warn', '手机推送失败（网络错误）：' + (title || ''));
  }
}

async function notifyMatches(fresh) {
  logEvent('ok', '桌面通知：有空位 ' + fresh.slice(0, 5).map((m) => m.date).join('、'));
  for (const match of fresh.slice(0, 5)) {
    const id = ['slot', match.date, match.post || '', Date.now()].join('|');
    const times = (match.times || []).slice(0, 4).join(', ');
    const where = match.post ? match.post + ' — ' : '';
    chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('assets/icon128.png'),
      title: '有空位：' + match.date,
      message: where + (times || '有空位') + '\n点击跳转到该日期。',
      priority: 2,
      silent: true,
      requireInteraction: true,
      buttons: [{ title: '查看' }]
    }, () => void chrome.runtime.lastError);
  }
}

async function openForMatch(notificationId) {
  const parts = notificationId.split('|');
  const date = parts[1];
  const post = parts[2];
  if (!date) return;
  await chrome.storage.local.set({ highlightTarget: { date, post, setAt: Date.now() } });

  // Prefer a portal tab that is already open — this must not create traffic the user
  // did not ask for.
  const tabs = await chrome.tabs.query({ url: PORTAL_GLOBS });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: PORTAL_URL, active: true });

  chrome.notifications.clear(notificationId);
}

/**
 * Brings the tab showing a verification challenge to the front.
 *
 * An automatic check runs in a background tab, so a challenge raised during one is
 * invisible by construction — the cycle is stalled behind an interstitial nobody can see.
 * This is the whole remedy the extension can offer: it cannot answer the challenge, so
 * the least it can do is put it in front of the person who can, in one click.
 */
async function focusChallengeTab(notificationId) {
  chrome.notifications.clear(notificationId);
  const { challengeTabId } = await chrome.storage.local.get('challengeTabId');
  try {
    if (challengeTabId) {
      const tab = await chrome.tabs.get(challengeTabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(challengeTabId, { active: true });
      return;
    }
  } catch { /* the tab was closed; fall through to any portal tab */ }

  const tabs = await chrome.tabs.query({ url: PORTAL_GLOBS });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
}

function handleNotificationClick(id) {
  if (id.startsWith('slot|')) return openForMatch(id);
  if (id.startsWith('verify|')) return focusChallengeTab(id);
}

chrome.notifications.onClicked.addListener(handleNotificationClick);
chrome.notifications.onButtonClicked.addListener(handleNotificationClick);

/**
 * The portal tab you are looking at right now, if any.
 *
 * An automatic check must never reload this one — you could be halfway through booking in
 * it. Requiring the window to hold OS focus is what keeps this from being permanent: a
 * portal tab left active in an unfocused window is not a tab anyone is using.
 */
async function focusedPortalTabId() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || !win.focused) return null;
    const [tab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (!tab || !PORTAL_HOST.test(tab.url || '')) return null;
    return tab.id;
  } catch {
    return null;                        // no windows API answer means nothing to protect
  }
}

/**
 * Opens the schedule page and asks the page script to pre-select post and applicant.
 *
 * `auto` says who asked. A manual check always comes forward and takes focus, because a
 * person is waiting on it. An automatic one leaves focus alone unless you asked
 * otherwise — a check every ten minutes that steals the foreground is a check you turn
 * off within the hour — and yields entirely if the only portal tab is the one in front of
 * you.
 *
 * Returns 'started' or 'busy'.
 */
async function startQuickCheck({ auto = false } = {}) {
  const settings = await getSettings();

  // The focused portal tab is normally off-limits to an automatic check, so a cycle can
  // never reload a tab you are booking in. autoCheckWhileActive opts out of that guard:
  // the tab you are on becomes an ordinary candidate and gets reloaded like any other.
  const busyId = (auto && !settings.autoCheckWhileActive)
    ? await focusedPortalTabId()
    : null;

  // Portal tabs before identity-provider tabs: a tab parked on the sign-in page is the
  // worst one to commandeer, since navigating it away abandons a sign-in mid-flight.
  const tabs = (await chrome.tabs.query({ url: PORTAL_GLOBS }))
    .filter((t) => t.id !== busyId)
    .sort((a, b) => Number(/b2clogin/.test(a.url || '')) -
      Number(/b2clogin/.test(b.url || '')));

  // Opening a second portal tab beside the one you are using would fight the session and
  // pile up tabs. Skipping the cycle is the honest outcome, and the popup reports it.
  if (!tabs.length && busyId) return 'busy';

  await chrome.storage.local.set({
    quickCheckRequest: {
      post: settings.preferredPost || '',
      auto,
      hops: 0,
      stage: 'select',
      setAt: Date.now()
    }
  });
  await setState({ checkStartedAt: Date.now() });
  await chrome.alarms.create(WATCHDOG_ALARM, { when: Date.now() + CHECK_TIMEOUT_MIN * 60000 });
  logEvent('info', (auto ? '开始自动检查' : '开始手动检查') +
    (tabs.length ? '（使用已打开的预约网站标签页）' : '（打开新标签页）'));

  const focus = auto ? Boolean(settings.autoCheckFocus) : true;

  if (!tabs.length) {
    await chrome.tabs.create({ url: PORTAL_URL, active: focus });
    return 'started';
  }

  const tab = tabs[0];
  const strip = (u) => String(u || '').split(/[?#]/)[0].replace(/\/+$/, '');
  const alreadyThere = strip(tab.url) === strip(PORTAL_URL);

  if (focus) await chrome.tabs.update(tab.id, { active: true });

  // Navigating to the URL you are already on is a no-op, so the content script would
  // never re-run and the request flag would sit unconsumed. Reload explicitly instead.
  if (alreadyThere) await chrome.tabs.reload(tab.id);
  else await chrome.tabs.update(tab.id, { url: PORTAL_URL });
  return 'started';
}

/* ------------------------------------------------------ automatic checking */

/**
 * Schedules the next automatic check.
 *
 * A one-shot alarm re-armed after every cycle, rather than a periodic one, because that
 * is what lets each interval carry its own jitter and its own backoff multiplier. A
 * periodic alarm would fix the cadence for the life of the worker.
 */
async function armAutoCheck(overrideMinutes) {
  await chrome.alarms.clear(AUTO_ALARM);

  const settings = await getSettings();
  if (!settings.enabled || !settings.autoCheck) {
    await setState({ nextAutoAt: 0 });
    return;
  }

  const state = await getState();

  // With a steady interval, refusals no longer stretch the wait: the delay is always the
  // interval you set (still jittered). A block or a challenge already suppresses the actual
  // check for as long as it is up — see runAutoCheck — so holding the cadence here does not
  // mean hammering a portal that is refusing; it just stops your 5 minutes turning into 20.
  const failures = settings.steadyInterval ? 0 : (state.autoFailures || 0);
  const delay = overrideMinutes || nextDelayMinutes(
    settings.autoCheckMinutes, settings.autoCheckJitterPct, failures);

  await chrome.alarms.create(AUTO_ALARM, { delayInMinutes: delay });
  await setState({ nextAutoAt: Date.now() + delay * 60000 });
  logEvent('info', '下次自动检查：' + clock(Date.now() + delay * 60000) +
    '（约 ' + Math.round(delay) + ' 分钟后）');
}

/** Records a refused or failed cycle so the next one waits longer. */
async function autoFailed(detail) {
  const state = await getState();
  const failures = (state.autoFailures || 0) + 1;
  await setState(detail ? { autoFailures: failures, detail } : { autoFailures: failures }, 'warn');
}

/* --------------------------------------------- queue / rate-limit waiting */

/**
 * Starts (or continues) a wait the site imposed — its virtual queue or a rate limit.
 *
 * Nothing is reloaded or clicked while it lasts: the page may forward itself on, and the
 * check carries on from there. The clock starts at the first sighting and is not reset by
 * the page's own refreshes, so RETRY_ALARM fires the configured time after the wait began.
 */
async function beginWait(status, detail) {
  const [settings, state] = await Promise.all([getSettings(), getState()]);
  const continuing = state.status === status && state.waitSince;
  const since = continuing ? state.waitSince : Date.now();
  // The queue page refreshes itself, re-reporting each time; only the start is news.
  await saveState({ status, detail, waitSince: since });
  if (!continuing) {
    logEvent('warn', detail + '（最多等 ' + Math.round(waitLimitMs(settings) / 60000) + ' 分钟）');
  }
  await badge('', BADGE.warn);
  await chrome.alarms.create(RETRY_ALARM, { when: since + waitLimitMs(settings) });
}

/**
 * The wait ran past the limit without the page moving on: run this round's check again
 * from the start. A wait that did end on its own has already changed the status, so the
 * alarm finds nothing to do.
 */
async function retryAfterWait() {
  const state = await getState();
  if (state.status !== QUEUED && state.status !== RATE_LIMITED) return;

  const settings = await getSettings();
  const what = state.status === QUEUED ? '网站排队' : '限流';
  await setState({
    status: 'idle',
    waitSince: 0,
    detail: what + '已等待 ' + Math.round(waitLimitMs(settings) / 60000) +
      ' 分钟仍未通过——重新开始本轮检查'
  });
  await badge('', BADGE.idle);
  if (!settings.enabled) return;

  try {
    await startQuickCheck({ auto: Boolean(settings.autoCheck) });
  } catch (e) {
    await autoFailed('无法重新开始检查——' + String(e.message || e));
  }
}

/**
 * An access limitation: automatic checking is switched off and stays off until you turn
 * it back on in Settings. Nothing retries a block — each attempt only digs it deeper.
 */
async function stopForBlock(detail, extra = {}) {
  const settings = await getSettings();
  await setSettings({ ...settings, autoCheck: false });
  await chrome.alarms.clear(RETRY_ALARM);
  await setState({ status: BLOCKED, detail, waitSince: 0, checkDoneAt: Date.now(), ...extra });
  await badge('!', BADGE.stop);
  await armAutoCheck();                    // autoCheck is now off: clears the alarm
  notifyPhone('预约网站拒绝访问', detail + '。自动检查已关闭——过一段时间再到设置里重新打开。',
    { priority: 4, tags: 'no_entry' });
}

/* ------------------------------------------------- failures and the watchdog */

/*
 * Every check ends in exactly one of: a result (pushed with the dates), or a failure
 * (pushed with the reason). checkDoneAt marks that it ended; the watchdog covers the
 * case where neither ever arrives — a page that never loads, as during a site outage,
 * runs no script that could report anything.
 */
async function reportFailure(text) {
  await saveState({ checkDoneAt: Date.now() });
  notifyPhone('检查失败', text, { priority: 3, tags: 'warning' });
}

async function checkWatchdog() {
  const state = await getState();
  if (!state.checkStartedAt || (state.checkDoneAt || 0) >= state.checkStartedAt) return;
  // A queue or rate-limit wait runs on its own timer and reruns the check itself.
  if (state.status === QUEUED || state.status === RATE_LIMITED) return;

  const why = state.status === CHALLENGE
    ? '卡在人机验证，需要你去完成'
    : '页面可能没有打开（网站维护、网络问题或页面一直没加载出来）';
  const text = '检查开始 ' + CHECK_TIMEOUT_MIN + ' 分钟了还没有结果——' + why;
  await setState({ detail: text }, 'warn');
  await reportFailure(text);
}

async function runAutoCheck() {
  const settings = await getSettings();
  if (!settings.enabled || !settings.autoCheck) return armAutoCheck();

  const state = await getState();

  // Blocked, waiting on a challenge, or sitting out a queue / rate limit: no new check this
  // cycle. A block has already switched automatic checking off, so it never gets here.
  if (state.status === BLOCKED || state.status === CHALLENGE ||
      state.status === QUEUED || state.status === RATE_LIMITED) {
    if (state.status === BLOCKED) {
      return armAutoCheck();
    } else if (state.status === QUEUED || state.status === RATE_LIMITED) {
      // A check is already holding in it, so starting a second one would reload the tab and
      // lose your place. RETRY_ALARM restarts it once the limit passes; this is the backstop
      // in case that alarm was lost.
      if (state.waitSince && Date.now() - state.waitSince >= waitLimitMs(settings)) {
        await retryAfterWait();
      }
    } else {
      // A challenge is a pause waiting on you, not a refusal, so it must not compound
      // into backoff. Doubling the interval every time one appeared meant that clearing
      // them promptly still left the next check an hour away — punishing you for the one
      // part of this that only you can do.
      await setState({ detail: '等待你完成人机验证' });
    }
    return armAutoCheck();
  }

  // Re-arm in a finally: a one-shot alarm that fails to reschedule itself doesn't retry
  // later, it stops forever, and the popup would go on claiming a check is coming.
  try {
    const outcome = await startQuickCheck({ auto: true });
    await setState(outcome === 'busy'
      // Not a failure, so no backoff: it retries at the normal interval, and the moment
      // you switch away it goes through.
      ? { detail: '跳过本次自动检查——你正在使用预约网站的标签页' }
      : { lastAutoAt: Date.now() });
  } catch (e) {
    await autoFailed('无法打开预约页面——' + String(e.message || e));
  } finally {
    await armAutoCheck();
  }
}

/* ----------------------------------------------- availability seen on page */

async function handleAvailability(payload) {
  const settings = await getSettings();

  // Only checks the extension started are read. A calendar you open yourself, outside one,
  // is your own browsing and is left alone — no state, no notification, no phone push.
  const { checkStartedAt } = await getState();
  if (!checkStartedAt || Date.now() - checkStartedAt > checkWindowMs(settings)) return;

  const verdict = triage(payload.status, payload.sample, payload.url);
  // Anything but a challenge settles this check; a challenge is a pause, not an outcome.
  if (verdict.kind !== CHALLENGE) await saveState({ checkDoneAt: Date.now() });

  const lastResponse = {
    ...describeResponse(payload.status, payload.sample, payload.url),
    verdict: verdict.kind,
    reason: verdict.reason
  };

  if (verdict.kind === BLOCKED) {
    await stopForBlock(verdict.reason, { lastSeenAt: Date.now(), lastResponse });
    return;
  }
  if (verdict.kind === RATE_LIMITED) {
    await setState({ lastSeenAt: Date.now(), lastResponse });
    await beginWait(RATE_LIMITED, verdict.reason);
    return;
  }

  if (verdict.kind === CHALLENGE) {
    await setState({
      status: verdict.kind,
      detail: verdict.reason,
      lastSeenAt: Date.now(),
      lastResponse
    });
    // Counts against the automatic cycle even when the refusal arrived during a check you
    // ran by hand — the portal's mood is not per-caller.
    await autoFailed();
    await badge('!', BADGE.warn);
    await armAutoCheck();
    return;
  }

  const extracted = extractDates(payload.sample);
  if (extracted.error) {
    await setState({
      status: 'error',
      detail: '无法读取日历数据',
      lastSeenAt: Date.now(),
      lastShape: describeShape(payload.sample, 40)
    });
    await reportFailure('无法读取日历数据');
    return;
  }

  mergeResult(extracted, payload);
}

/*
 * One check can bring more than one calendar response — the page sometimes asks for the
 * calendar twice — and reporting each one separately pushed the same result twice. So the
 * responses of a check are merged, and reported once they have been quiet for SETTLE_MS.
 */
const SETTLE_MS = 4000;
let pendingResult = null;   // { checkStartedAt, dates: Map, shape, timer }

async function mergeResult(extracted, payload) {
  const { checkStartedAt } = await getState();
  if (!pendingResult || pendingResult.checkStartedAt !== checkStartedAt) {
    if (pendingResult) clearTimeout(pendingResult.timer);
    pendingResult = { checkStartedAt, dates: new Map(), shape: null, timer: 0 };
  }
  const result = pendingResult;
  for (const d of extracted.dates) result.dates.set((d.post || '') + '|' + d.date, d);
  if (extracted.suspect) result.shape = describeShape(payload.sample, 40);

  clearTimeout(result.timer);
  result.timer = setTimeout(() => { reportResult(result).catch(() => {}); }, SETTLE_MS);
}

async function reportResult(result) {
  if (pendingResult === result) pendingResult = null;

  const [settings, state] = await Promise.all([getSettings(), getState()]);
  const dates = [...result.dates.values()];
  const matches = filterMatches(dates, settings);
  const diff = diffNew(matches, await getSeen());
  await setSeen(diff.seen);

  // A response that straggles in after this check was already reported is pushed again
  // only if it brings a new match — that is news; a repeat of the same result is not.
  const firstReport = state.resultReportedFor !== result.checkStartedAt;
  await saveState({ resultReportedFor: result.checkStartedAt });

  if (diff.fresh.length) await notifyMatches(diff.fresh);

  // Every open day the calendar showed, in or out of your range — kept as reference so the
  // popup can show what IS available even when nothing matches your conditions.
  const available = dates
    .filter((d) => d.available)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => ({ date: d.date, post: d.post || '', times: (d.times || []).slice(0, 4) }));

  // The per-check result to your phone: one per check, match or not, always listing the
  // open dates the calendar showed (or saying there are none). A new match is an urgent
  // alert with a tap-to-open-portal action.
  const label = (d) => d.date + (d.post ? ' (' + d.post + ')' : '');
  const openList = available.length
    ? '可选日期：' + available.slice(0, 15).map(label).join(', ')
      + (available.length > 15 ? ' 等，另有 ' + (available.length - 15) + ' 个' : '')
    : '没有可选日期。';
  if (firstReport || diff.fresh.length) {
    if (matches.length) {
      notifyPhone(diff.fresh.length ? '发现空位，快去预约！' : '检查完成：空位仍在',
        '你的日期范围内有 ' + matches.length + ' 个：' + matches.slice(0, 6).map(label).join(', ')
          + '\n' + openList,
        diff.fresh.length
          ? { priority: 5, tags: 'tada,rotating_light', click: PORTAL_URL }
          : { priority: 4, tags: 'white_check_mark', click: PORTAL_URL });
    } else {
      notifyPhone('检查完成：没有符合的空位', openList, { priority: 2, tags: 'mag' });
    }
  }

  await setState({
    status: 'ok',
    detail: dates.length
      ? '看到 ' + dates.length + ' 个日期，其中 ' + matches.length + ' 个在你的范围内'
      : '日历上没有可选日期',
    lastSeenAt: Date.now(),
    lastMatches: matches.slice(0, 50),
    lastAvailable: available.slice(0, 100),
    lastShape: result.shape,
    autoFailures: 0            // a readable calendar clears any accumulated backoff
  });
  logEvent(matches.length ? 'ok' : 'info', (matches.length
    ? '范围内的空位：' + matches.slice(0, 15).map(label).join(', ') + '。'
    : '') + openList);
  await badge(matches.length ? String(matches.length) : '',
    matches.length ? BADGE.ok : BADGE.idle);
}

/* --------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === 'AVAILABILITY') {
    handleAvailability(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, detail: String(e.message || e) }));
    return true;
  }

  // The verification challenge is yours to clear — nothing here interacts with it.
  // What the extension can do is make sure you notice it immediately, since these
  // expire, and a challenge sitting unnoticed is a calendar you think you are watching
  // but aren't.
  if (message.type === 'CHALLENGE_SEEN') {
    (async () => {
      // Remember which tab, so the notification can take you straight to it.
      if (sender.tab && sender.tab.id) {
        await chrome.storage.local.set({ challengeTabId: sender.tab.id });
      }

      const state = await getState();
      if (state.status !== CHALLENGE) {
        const settings = await getSettings();

        // Flash the window in the taskbar rather than seizing focus. A challenge in a
        // background tab is otherwise silent, but yanking the foreground away from
        // whatever you are typing into is not a fair trade for a checkbox.
        if (sender.tab && sender.tab.windowId !== undefined) {
          try {
            await chrome.windows.update(sender.tab.windowId, { drawAttention: true });
          } catch { /* the window may already be gone */ }
        }

        chrome.notifications.create('verify|' + Date.now(), {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('assets/icon128.png'),
          title: '需要人机验证',
          message: '预约网站要求确认你是真人。点击打开该标签页——完成验证后检查会自动继续。',
          priority: 2,
          silent: true,
          // It stays until acted on: a challenge that scrolls out of the notification
          // centre unnoticed is a watcher you think is running and isn't.
          requireInteraction: true,
          buttons: [{ title: '打开该标签页' }]
        }, () => void chrome.runtime.lastError);

        // A single reload of the challenge page, if you asked for one. This does NOT
        // clear the challenge — you still click it yourself; the reload only loads the
        // page once more. It runs exactly once per challenge: this whole block is guarded
        // by status !== CHALLENGE, and status becomes CHALLENGE immediately below, so the
        // reloaded page's own CHALLENGE_SEEN cannot re-enter here and start a reload loop.
        if (settings.refreshOnChallenge && sender.tab && sender.tab.id) {
          try { await chrome.tabs.reload(sender.tab.id); }
          catch { /* the tab was closed; nothing to reload */ }
        }
      }
      await setState({ status: CHALLENGE, detail: message.detail || '预约网站出现人机验证' });
      await badge('!', BADGE.warn);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'CHALLENGE_CLEARED') {
    (async () => {
      const state = await getState();

      // Only the tab that carried the challenge may clear it. A clear page loading in some
      // other tab must not wave off a challenge still up in the one that has it. When no
      // challenge tab was recorded, there is nothing to protect, so allow it.
      const { challengeTabId } = await chrome.storage.local.get('challengeTabId');
      const fromChallengeTab = !challengeTabId || !sender.tab || sender.tab.id === challengeTabId;

      if (state.status === CHALLENGE && fromChallengeTab) {
        await setState({ status: 'idle', detail: '验证已通过——继续检查' });
        await badge('', BADGE.idle);
        await chrome.storage.local.remove('challengeTabId');

        // You did the part only you can do, so the backoff earned by the challenge is
        // written off. The next check then falls on your normal interval — it is not pulled
        // forward, which used to leave an uncomfortably short gap right after a challenge.
        await setState({ autoFailures: 0 });
        await armAutoCheck();
      }
      sendResponse({ ok: true });
    })();
    return true;
  }

  // The site is holding the check in its virtual queue, or rate-limiting it. Not a failure:
  // the page may forward itself on, and the content script holds the check open meanwhile.
  // If it has not moved on within the configured limit, RETRY_ALARM reruns the check.
  if (message.type === 'QUEUE_SEEN' || message.type === 'RATE_LIMITED') {
    (async () => {
      await (message.type === 'QUEUE_SEEN'
        ? beginWait(QUEUED, message.detail || '正在网站排队')
        : beginWait(RATE_LIMITED, message.detail || '被预约网站限流'));
      sendResponse({ ok: true });
    })();
    return true;
  }

  // Auto-book could not act (nothing matched, or the selection did not verify). This is not
  // a portal refusal, so it records a detail line only — never a failure, which would back
  // off the interval and stop the checks following the cadence you set.
  if (message.type === 'BOOK_NOTE') {
    (async () => {
      await setState({ detail: message.detail || '自动预约未执行' });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // An irreversible action just happened on your behalf. Always surface it loudly — a
  // booking submitted silently in a background tab is the worst thing to miss.
  if (message.type === 'AUTO_BOOKING') {
    (async () => {
      notifyPlain('预约已提交',
        (message.detail || '插件已提交一个预约。') +
        ' 请打开预约网站确认是否成功。');
      await setState({ detail: message.detail || '已提交预约' }, 'ok');
      notifyPhone('预约已提交', (message.detail || '已提交一个预约。') +
        ' 请在预约网站上确认。', { priority: 5, tags: 'calendar', click: PORTAL_URL });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'PORTAL_BLOCKED') {
    (async () => {
      notifyPlain('预约网站拒绝访问',
        '出现了访问受限提示，自动检查已关闭。先别访问这个网站一段时间，再到设置里重新打开。');
      await stopForBlock(message.detail || '预约网站显示访问受限');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'OBSERVED') {
    (async () => {
      const got = await chrome.storage.local.get('observed');
      const log = Array.isArray(got.observed) ? got.observed : [];
      const entry = message.entry;

      const key = entry.method + ' ' + entry.path + ' ' + (entry.params || []).join(',');
      const existing = log.find((e) => e.key === key);
      if (existing) {
        existing.count++;
        existing.at = entry.at;
        if (entry.hasDates) existing.hasDates = true;
      } else {
        log.push({ ...entry, key, count: 1 });
      }

      await chrome.storage.local.set({ observed: log.slice(-60) });
      sendResponse({ ok: true });
    })();
    return true;
  }

  // What a sign-in step saw. Redacted at the source — presence and counts, no values.
  if (message.type === 'SIGNIN_TRACE') {
    (async () => {
      const got = await chrome.storage.local.get('signinTrace');
      const log = Array.isArray(got.signinTrace) ? got.signinTrace : [];
      log.push(message.entry);
      await chrome.storage.local.set({ signinTrace: log.slice(-12) });
      const entry = message.entry || {};
      const step = {
        login: '登录：在账号密码页', identifier: '登录：在邮箱页', question: '登录：在安全问题页'
      }[entry.page];
      if (step) logEvent('info', step);
      if (entry.page === 'submit') logEvent('info', '登录：已提交表单');
      if (entry.gaveUp) logEvent('warn', '页面加载次数过多，放弃本次检查');
      sendResponse({ ok: true });
    })();
    return true;
  }

  // A progress banner the check showed on the portal page.
  if (message.type === 'LOG') {
    logEvent(message.level || 'info', message.text, 'page')
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'GET_STATUS') {
    (async () => {
      const [settings, state] = await Promise.all([getSettings(), getState()]);
      const got = await chrome.storage.local.get(['observed', 'signinTrace']);
      sendResponse({
        settings,
        state,
        observed: Array.isArray(got.observed) ? got.observed : [],
        signinTrace: Array.isArray(got.signinTrace) ? got.signinTrace : []
      });
    })();
    return true;
  }

  if (message.type === 'RESET') {
    (async () => {
      await chrome.storage.local.remove(
        ['state', 'seen', 'observed', 'signinTrace', 'highlightTarget']);
      await badge('', BADGE.idle);
      logEvent('info', '已重置状态和诊断数据');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'CLEAR_OBSERVED') {
    chrome.storage.local.remove(['observed', 'signinTrace'])
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  // The automatic cycle could not get as far as a calendar. Reported by the page script,
  // because only the page can tell a sign-in form from a schedule page.
  if (message.type === 'AUTO_NEEDS_LOGIN') {
    (async () => {
      notifyPlain('已被登出预约网站',
        (message.detail || '预约网站已将你登出') + '。请自己登录。');
      await autoFailed('自动检查已停止——' + (message.detail || '已被登出'));
      await reportFailure('需要登录——' + (message.detail || '预约网站已将你登出'));
      await badge('!', BADGE.warn);
      await armAutoCheck();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'AUTO_FAILED') {
    (async () => {
      await autoFailed('自动检查失败——' + (message.detail || '原因未知'));
      await reportFailure(message.detail || '原因未知');
      await armAutoCheck();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // The portal's own maintenance page. Not a failure of ours and not a refusal: this round
  // ends, no backoff, and the next one is tried on the normal interval.
  if (message.type === 'MAINTENANCE') {
    (async () => {
      const text = '预约网站正在维护' + (message.detail ? '：' + message.detail : '');
      await setState({ status: 'idle', detail: text + '——按正常间隔继续尝试' }, 'warn');
      await badge('', BADGE.warn);
      await reportFailure(text);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'TEST_PHONE') {
    notifyPhone('测试推送', 'ntfy 已连接——之后的检查结果会推送到这里。',
      { priority: 3, tags: 'bell' })
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'QUICK_CHECK') {
    startQuickCheck()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, detail: String(e.message || e) }));
    return true;
  }

  if (message.type === 'SETTINGS_SAVED') {
    (async () => {
      // A settings change is the user paying attention, so it also clears the backoff —
      // otherwise fixing a wrong password still leaves you waiting out a 160-minute wait.
      await setState({ autoFailures: 0 });

      // Switching automatic checking back on is how a block is dealt with.
      const [settings, state] = await Promise.all([getSettings(), getState()]);
      logEvent('info', !settings.enabled ? '已暂停'
        : '设置已更新——自动检查' + (settings.autoCheck
          ? '开启，每 ' + settings.autoCheckMinutes + ' 分钟' : '关闭'));
      if (settings.autoCheck && state.status === BLOCKED) {
        await setState({ status: 'idle', detail: '自动检查已恢复' });
        await badge('', BADGE.idle);
      }
      // A changed wait limit applies to a wait already under way.
      if ((state.status === QUEUED || state.status === RATE_LIMITED) && state.waitSince) {
        await chrome.alarms.create(RETRY_ALARM,
          { when: Math.max(Date.now() + 1000, state.waitSince + waitLimitMs(settings)) });
      }

      await armAutoCheck();
      sendResponse({ ok: true });
    })();
    return true;
  }

  return;
});

/* -------------------------------------------------------------- lifecycle */

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_ALARM) runAutoCheck();
  if (alarm.name === RETRY_ALARM) retryAfterWait();
  if (alarm.name === WATCHDOG_ALARM) checkWatchdog();
});

chrome.runtime.onStartup.addListener(() => { armAutoCheck(); });

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  logEvent('info', '插件已安装或更新：v' + chrome.runtime.getManifest().version);

  // Automatic checking is opt-in on every install, including an upgrade. Something that
  // browses a government scheduling portal on a timer should never arrive switched on
  // because a version number changed.
  await setSettings({ ...settings, enabled: true, autoCheck: Boolean(settings.autoCheck) });

  await chrome.storage.local.remove(['template', 'quickCheckRequest']);
  await chrome.storage.session.remove('auraToken');

  const state = await getState();
  if (state.status === BLOCKED || state.status === CHALLENGE ||
      state.status === QUEUED || state.status === RATE_LIMITED) {
    await setState({ status: 'idle', detail: '', pausedReason: '', waitSince: 0 });
  }
  await chrome.alarms.clear(RETRY_ALARM);
  await setState({ autoFailures: 0 });
  await badge('', BADGE.idle);
  // The check reminder was removed; drop any alarm an older version left running.
  await chrome.alarms.clear('vsw-reminder');
  await armAutoCheck();
});
