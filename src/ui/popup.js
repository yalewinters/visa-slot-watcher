const $ = (id) => document.getElementById(id);

// The root, not /en-US/schedule/: the portal is a single-page app that boots from the
// site root, and deep-linking into the calendar does not reliably come up.
const PORTAL_URL = 'https://www.usvisascheduling.com/';

const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => {
    void chrome.runtime.lastError;
    resolve(response || {});
  });
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function relative(ts) {
  if (!ts) return '从未';
  const secs = Math.round((Date.now() - ts) / 1000);
  if (secs < 60) return secs + ' 秒前';
  if (secs < 3600) return Math.round(secs / 60) + ' 分钟前';
  if (secs < 86400) return Math.round(secs / 3600) + ' 小时前';
  return Math.round(secs / 86400) + ' 天前';
}

function until(ts) {
  const secs = Math.round((ts - Date.now()) / 1000);
  if (secs <= 0) return '马上';
  if (secs < 90) return secs + ' 秒后';
  if (secs < 5400) return Math.round(secs / 60) + ' 分钟后';
  return Math.round(secs / 3600) + ' 小时后';
}

/**
 * The right-hand meta line. Worth being exact about: "next check in 40 min" when you
 * configured 10 is the only visible sign that the portal refused something and the cycle
 * has backed off.
 */
function scheduleLine(settings, state) {
  if (!settings.enabled) return '已暂停';
  if (!settings.autoCheck) return '自动检查未开启';
  if (!state.nextAutoAt) return '自动检查——正在安排…';

  // With a steady interval the failure count no longer stretches the wait, so it must not
  // be shown as if it did.
  const backoff = state.autoFailures && !settings.steadyInterval
    ? '（已放慢 ×' + 2 ** Math.min(4, state.autoFailures) + '）'
    : '';
  return until(state.nextAutoAt) + '自动检查' + backoff;
}

const STATUS = {
  ok: { dot: 'ok', text: '监控中' },
  idle: { dot: '', text: '等待检查' },
  error: { dot: 'warn', text: '无法读取结果' },
  challenge: { dot: 'warn', text: '需要人机验证' },
  blocked: { dot: 'stop', text: '预约网站拒绝访问' },
  queued: { dot: 'warn', text: '正在网站排队' },
  ratelimited: { dot: 'warn', text: '被限流——等待中' }
};

const BANNERS = {
  idle: {
    kind: 'warn',
    html: '在设置里打开<b>自动检查</b>，或者点<b>立即检查</b>运行一次。' +
          '插件只读取它自己发起的检查——你自己浏览日历时不会读取。'
  },
  challenge: {
    kind: 'warn',
    html: '预约网站要求确认你是真人。<b>请在预约网站的标签页里完成验证</b>——' +
          '正在进行的登录只是暂停，不会取消，验证一过就会继续。只需要你点一下，' +
          '也不会拉长检查间隔。<br><br>' +
          '插件从不替你点验证。验证本来就是用来识别脚本点击的，' +
          '伪造点击只会换来更难的验证，甚至账号被封。'
  },
  blocked: {
    kind: 'stop',
    html: '预约网站显示访问受限。<b>自动检查已关闭</b>，不会再重试。' +
          '先别访问这个网站一段时间，再到设置里重新打开自动检查。'
  },
  queued: {
    kind: 'warn',
    html: '网站访问量大，正在让你<b>排队</b>。这不是封禁，也不需要你做什么——' +
          '排到后页面会自动跳转到日历，检查会接着进行。' +
          '超过设置里的等待上限还没排到，就会重新检查。'
  },
  ratelimited: {
    kind: 'warn',
    html: '预约网站正在<b>限流</b>。期间插件不刷新也不点击；' +
          '超过设置里的等待上限还没恢复，就从头重新检查。'
  }
};

/** A clickable day row that deep-links to that date on the portal. Shared by both lists. */
function dayRow(item) {
  const li = document.createElement('li');
  li.title = '在预约网站上跳转到这个日期';

  const date = document.createElement('span');
  date.className = 'date';
  date.textContent = item.date;

  const post = document.createElement('span');
  post.className = 'post';
  post.textContent = [item.post, (item.times || []).slice(0, 3).join(', ')]
    .filter(Boolean).join(' · ');

  li.append(date, post);
  li.addEventListener('click', async () => {
    await chrome.storage.local.set({
      highlightTarget: { date: item.date, post: item.post, setAt: Date.now() }
    });
    openPortal();
  });
  return li;
}

function renderMatches(matches) {
  const list = $('matches');
  list.innerHTML = '';
  const has = matches && matches.length;
  $('noMatches').hidden = Boolean(has);
  if (!has) return;
  for (const match of matches) list.appendChild(dayRow(match));
}

/**
 * Every open day the calendar showed, matching or not, as reference. Shown even when
 * nothing is in range, so an empty match list does not read as "nothing open anywhere".
 */
function renderAllDays(available) {
  const list = $('allDays');
  list.innerHTML = '';
  const days = available || [];
  $('allDaysWrap').hidden = days.length === 0;
  $('allDaysCount').textContent = String(days.length);
  for (const day of days) list.appendChild(dayRow(day));
}

/** Reuse an open portal tab rather than creating traffic the user didn't ask for. */
async function openPortal() {
  const tabs = await chrome.tabs.query({
    url: ['https://*.usvisascheduling.com/*', 'https://atlasauth.b2clogin.com/*']
  });
  if (tabs.length) await chrome.tabs.update(tabs[0].id, { active: true });
  else await chrome.tabs.create({ url: PORTAL_URL });
  window.close();
}

async function refresh() {
  const status = await send({ type: 'GET_STATUS' });
  if (!status.state) return;

  const { settings, state } = status;
  const look = STATUS[state.status] || STATUS.idle;

  $('dot').className = 'dot ' + look.dot;
  $('headline').textContent = !settings.enabled ? '已暂停'
    : (state.status === 'idle' && settings.autoCheck) ? '自动检查中'
      : look.text;
  $('detail').textContent = state.detail || '还没有结果。';
  $('lastCheck').textContent = '上次读到日历：' + relative(state.lastSeenAt);
  $('nextRun').textContent = scheduleLine(settings, state);

  const banner = settings.enabled && !(state.status === 'idle' && settings.autoCheck)
    ? BANNERS[state.status]
    : null;
  if (banner) {
    $('banner').hidden = false;
    $('banner').className = 'banner ' + banner.kind;
    const trigger = state.status === 'blocked' ? state.detail : '';
    $('banner').innerHTML = banner.html +
      (trigger ? '<br><br>原因：<b>' + escapeHtml(trigger) + '</b>' : '');
  } else {
    $('banner').hidden = true;
  }

  renderMatches(state.lastMatches);
  renderAllDays(state.lastAvailable);

  $('toggle').textContent = settings.enabled ? '暂停' : '继续';
}

// Opens the schedule page and pre-selects post + applicant. One user action, one check.
$('checkNow').addEventListener('click', async () => {
  await send({ type: 'QUICK_CHECK' });
  window.close();
});

$('toggle').addEventListener('click', async () => {
  const status = await send({ type: 'GET_STATUS' });
  const settings = status.settings || {};
  await chrome.storage.local.set({ settings: { ...settings, enabled: !settings.enabled } });
  // Pausing has to reach the worker: an armed auto-check alarm outlives a settings write
  // that nobody told it about, and a paused extension that still opens tabs is a bug.
  await send({ type: 'SETTINGS_SAVED' });
  refresh();
});

$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('openLog').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/log.html') });
});

// Stamping the running version makes "did the reload take effect?" answerable.
$('version').textContent = 'v' + chrome.runtime.getManifest().version;

refresh();
setInterval(refresh, 3000);
