import { getSettings, setSettings, getCreds, setCreds } from '../lib/storage.js';
import { MIN_INTERVAL_MINUTES, clampPct } from '../lib/jitter.js';

const $ = (id) => document.getElementById(id);

/** A stored password is never rendered back into the field; only its presence is shown. */
const KEPT = '•'.repeat(10);

async function load() {
  const settings = await getSettings();
  $('rangeStart').value = settings.rangeStart || '';
  $('rangeEnd').value = settings.rangeEnd || '';
  $('preferredPost').value = settings.preferredPost || '';
  $('ntfyTopic').value = settings.ntfyTopic || '';

  $('autoCheck').checked = Boolean(settings.autoCheck);
  $('autoCheckMinutes').value = settings.autoCheckMinutes || 10;
  $('autoCheckJitterPct').value = settings.autoCheckJitterPct ?? 30;
  $('autoCheckFocus').checked = Boolean(settings.autoCheckFocus);
  $('steadyInterval').checked = Boolean(settings.steadyInterval);
  $('autoCheckWhileActive').checked = Boolean(settings.autoCheckWhileActive);
  $('refreshOnChallenge').checked = Boolean(settings.refreshOnChallenge);
  $('autoBook').checked = Boolean(settings.autoBook);
  $('waitMinutes').value = settings.waitMinutes || 10;

  const creds = await getCreds();
  $('loginEmail').value = creds.email || '';
  $('loginPassword').value = creds.password ? KEPT : '';
  $('securityAnswers').value = (creds.answers || [])
    .map((entry) => entry.q + ' | ' + (entry.a ? KEPT : ''))
    .join('\n');
  syncAutoFields();
}

/** The credential rows only matter when automatic checking (which signs in) is on. */
function syncAutoFields() {
  const on = $('autoCheck').checked;
  for (const id of ['loginEmail', 'loginPassword', 'securityAnswers', 'forgetCreds']) {
    $(id).disabled = !on;
  }
  $('credWarn').style.opacity = on ? '1' : '.45';
}

/**
 * Parses the `question | answer` block, keeping any answer left as dots.
 *
 * Questions are rendered back verbatim, so an untouched line matches its stored entry
 * exactly and the real answer never has to be put on screen to survive a save.
 */
function parseAnswers(text, stored) {
  const previous = new Map((stored || []).map((entry) => [entry.q, entry.a]));

  return text.split('\n').map((line) => {
    const at = line.indexOf('|');
    if (at === -1) return null;
    const q = line.slice(0, at).trim();
    const typed = line.slice(at + 1).trim();
    if (!q) return null;
    const a = typed === KEPT ? (previous.get(q) || '') : typed;
    return a ? { q, a } : null;
  }).filter(Boolean);
}

async function save() {
  const settings = await getSettings();

  await setSettings({
    ...settings,
    rangeStart: $('rangeStart').value,
    rangeEnd: $('rangeEnd').value,
    preferredPost: $('preferredPost').value.trim(),
    ntfyTopic: $('ntfyTopic').value.trim(),

    autoCheck: $('autoCheck').checked,
    autoCheckMinutes: Math.min(600, Math.max(
      MIN_INTERVAL_MINUTES, Number($('autoCheckMinutes').value) || MIN_INTERVAL_MINUTES)),
    autoCheckJitterPct: clampPct($('autoCheckJitterPct').value),
    autoCheckFocus: $('autoCheckFocus').checked,
    steadyInterval: $('steadyInterval').checked,
    autoCheckWhileActive: $('autoCheckWhileActive').checked,
    refreshOnChallenge: $('refreshOnChallenge').checked,
    autoBook: $('autoBook').checked,
    waitMinutes: Math.min(120, Math.max(1, Math.round(Number($('waitMinutes').value) || 10)))
  });

  // The sentinel means "leave what is stored alone". An emptied box means "delete it",
  // which is the only way to remove a password without a separate destructive button.
  const typed = $('loginPassword').value;
  const existing = await getCreds();
  await setCreds({
    email: $('loginEmail').value.trim(),
    password: typed === KEPT ? existing.password : typed,
    answers: parseAnswers($('securityAnswers').value, existing.answers)
  });

  chrome.runtime.sendMessage({ type: 'SETTINGS_SAVED' }, () => void chrome.runtime.lastError);

  await load();
  $('savedNote').hidden = false;
  setTimeout(() => { $('savedNote').hidden = true; }, 2000);
}

$('save').addEventListener('click', save);
$('autoCheck').addEventListener('change', syncAutoFields);

$('forgetCreds').addEventListener('click', async () => {
  await setCreds(null);
  $('loginEmail').value = '';
  $('loginPassword').value = '';
  $('securityAnswers').value = '';
});

$('testPhone').addEventListener('click', async () => {
  // Persist the topic first so the background reads the value you just typed, then ping it.
  const settings = await getSettings();
  await setSettings({ ...settings, ntfyTopic: $('ntfyTopic').value.trim() });
  chrome.runtime.sendMessage({ type: 'TEST_PHONE' }, () => void chrome.runtime.lastError);
});

load();
