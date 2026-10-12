/**
 * The 操作记录 page: the activity log the worker writes (see logEvent in background.js),
 * plus the technical details that used to sit at the bottom of the popup.
 *
 * Reads chrome.storage directly and re-renders on every change, so it updates live while
 * a check runs.
 */

const $ = (id) => document.getElementById(id);

const LOG_KEY = 'activityLog';
const LEVEL_NAME = { info: '信息', ok: '结果', warn: '注意', error: '错误' };
const SOURCE_NAME = { ext: '插件', page: '网页' };
const FILTERS = {
  all: () => true,
  result: (e) => e.level !== 'info',
  problem: (e) => e.level === 'warn' || e.level === 'error'
};

const send = (message) => new Promise((resolve) => {
  chrome.runtime.sendMessage(message, (response) => {
    void chrome.runtime.lastError;
    resolve(response || {});
  });
});

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
};
const timeOf = (ms) => {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};

let entries = [];

function visible() {
  const keep = FILTERS[$('filter').value] || FILTERS.all;
  const q = $('search').value.trim().toLowerCase();
  return entries.filter((e) => keep(e) && (!q || String(e.text).toLowerCase().includes(q)));
}

function render() {
  const list = $('log');
  list.innerHTML = '';
  const shown = visible();
  $('count').textContent = '显示 ' + shown.length + ' / 共 ' + entries.length + ' 条';

  if (!shown.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = entries.length ? '没有符合筛选条件的记录。' : '还没有记录。运行一次检查后这里就会有内容。';
    list.appendChild(li);
    return;
  }

  // Newest first, with a heading row whenever the day changes.
  let lastDay = '';
  for (const e of [...shown].reverse()) {
    const day = dayOf(e.at);
    if (day !== lastDay) {
      const head = document.createElement('li');
      head.className = 'day';
      head.textContent = day;
      list.appendChild(head);
      lastDay = day;
    }

    const li = document.createElement('li');
    li.className = e.level || 'info';
    li.title = LEVEL_NAME[e.level] || '';

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = timeOf(e.at);

    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = SOURCE_NAME[e.source] || '插件';

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = e.text;

    li.append(time, src, text);
    list.appendChild(li);
  }
}

/** The visible entries as plain text, oldest first — for copying or saving. */
function asText() {
  return visible().map((e) =>
    dayOf(e.at) + ' ' + timeOf(e.at) + '  [' + (LEVEL_NAME[e.level] || '信息') + '/' +
    (SOURCE_NAME[e.source] || '插件') + ']  ' + e.text).join('\n');
}

async function loadLog() {
  const got = await chrome.storage.local.get(LOG_KEY);
  entries = Array.isArray(got[LOG_KEY]) ? got[LOG_KEY] : [];
  render();
}

/* ------------------------------------------------------- technical details */

let lastObservedText = '';

/** What the last calendar response looked like — for diagnosing a wrong verdict. */
function renderLastResponse(last) {
  if (!last) return '';
  const bits = [
    'LAST RESPONSE',
    '  verdict : ' + last.verdict + (last.reason ? ' — ' + last.reason : ''),
    '  status  : ' + last.status + '   type: ' + last.kind + '   ' + last.bytes + ' bytes'
  ];
  if (last.finalUrl) bits.push('  url     : ' + last.finalUrl);
  if (last.announced) bits.push('  page    : ' + last.announced);
  if (last.evidence) bits.push('  matched : …' + last.evidence + '…');
  return bits.join('\n');
}

/**
 * What each sign-in step saw. Presence and counts only — the content script never sends
 * a value, so there is nothing here to leak when this gets copied into a bug report.
 */
function renderTrace(trace) {
  if (!trace || !trace.length) return '';

  const lines = trace.slice(-8).map((e) => {
    const bits = ['  ' + (dayOf(e.at) + ' ' + timeOf(e.at)).padEnd(21) + (e.path || '/')];
    if (e.page === 'boot') {
      bits.push('    script ran, request pending: ' + (e.hasFlag ? 'yes' : 'NO') +
        (e.loads ? ' (page ' + e.loads + ' of this check)' : '') +
        (e.gaveUp ? ' — gave up, too many loads' : ''));
    } else if (e.page === 'submit') {
      bits.push('    submitted by: ' + e.how);
    } else {
      bits.push('    saw: ' + e.page +
        (e.usernameBox ? ', username box' : '') +
        (e.submitButton ? ', submit button' : ', NO submit button'));
      bits.push('    saved: ' + (e.autoLogin ? 'auto sign-in ON' : 'auto sign-in OFF') +
        ', password ' + (e.savedPassword ? 'yes' : 'NO') +
        ', answers ' + e.savedAnswers);
      if (e.answerBoxes !== undefined) {
        bits.push('    read ' + (e.questions || []).length + ' of ' + e.answerBoxes +
          ' answer boxes:');
        for (const q of e.questions || []) bits.push('      • ' + q);
      }
    }
    return bits.join('\n');
  });

  return 'SIGN-IN TRACE\n' + lines.join('\n\n');
}

/** Redacted request log — endpoint paths and parameter names only, never values. */
async function loadDetails() {
  const got = await chrome.storage.local.get(['observed', 'signinTrace', 'state']);
  const observed = Array.isArray(got.observed) ? got.observed : [];
  const trace = Array.isArray(got.signinTrace) ? got.signinTrace : [];
  const state = got.state || {};

  const sorted = [...observed].sort((a, b) =>
    (b.hasDates ? 1 : 0) - (a.hasDates ? 1 : 0) || b.count - a.count);

  const requestLog = sorted.map((e) => {
    const bits = [
      (e.hasDates ? '* ' : '  ') + e.method + ' ' + e.path,
      '    status ' + e.status + ', ' + e.bytes + ' bytes, seen ' + e.count + 'x'
    ];
    if (e.params && e.params.length) bits.push('    query: ' + e.params.join(', '));
    if (e.bodyKeys && e.bodyKeys.length) bits.push('    body: ' + e.bodyKeys.join(', '));
    if (e.actions && e.actions.length) bits.push('    actions: ' + e.actions.join(' | '));
    return bits.join('\n');
  }).join('\n\n');

  const shape = state.lastShape && state.lastShape.length
    ? 'RESPONSE STRUCTURE\n' + state.lastShape.map((l) => '  ' + l).join('\n')
    : '';

  lastObservedText = [
    renderTrace(trace),
    renderLastResponse(state.lastResponse),
    shape,
    requestLog ? 'REQUESTS SEEN\n' + requestLog : ''
  ].filter(Boolean).join('\n\n');

  $('observedHint').hidden = Boolean(lastObservedText);
  $('observedList').textContent = lastObservedText;
}

/* ------------------------------------------------------------------ wiring */

function flash(button, text) {
  const was = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = was; }, 1500);
}

$('filter').addEventListener('change', render);
$('search').addEventListener('input', render);

$('copyLog').addEventListener('click', async () => {
  await navigator.clipboard.writeText(asText() || '（没有记录）');
  flash($('copyLog'), '已复制');
});

$('exportLog').addEventListener('click', () => {
  const blob = new Blob([asText() + '\n'], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '操作记录-' + dayOf(Date.now()) + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('clearLog').addEventListener('click', async () => {
  if (!confirm('确定清空全部操作记录吗？清空后无法恢复。')) return;
  await chrome.storage.local.remove(LOG_KEY);
});

$('copyObserved').addEventListener('click', async () => {
  await navigator.clipboard.writeText(lastObservedText || '（还没有记录）');
  flash($('copyObserved'), '已复制');
});

$('clearObserved').addEventListener('click', () => send({ type: 'CLEAR_OBSERVED' }));
$('resetAll').addEventListener('click', () => send({ type: 'RESET' }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[LOG_KEY]) loadLog();
  if (changes.observed || changes.signinTrace || changes.state) loadDetails();
});

loadLog();
loadDetails();
