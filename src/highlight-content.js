/**
 * After a notification deep-link, finds the target date on the reschedule page and
 * outlines it. It scrolls and highlights only — it never selects or submits anything.
 */
(() => {
  'use strict';

  const STYLE_ID = 'vsw-highlight-style';
  const CSS = `
    .vsw-hit { outline: 3px solid #d93025 !important; outline-offset: 2px !important;
               border-radius: 4px !important; animation: vsw-pulse 1.2s ease-in-out 3; }
    @keyframes vsw-pulse { 50% { outline-color: #fbbc04 !important; } }
    .vsw-banner { position: fixed; z-index: 2147483647; top: 12px; left: 50%;
                  transform: translateX(-50%); background: #202124; color: #fff;
                  font: 13px/1.5 system-ui, sans-serif; padding: 10px 16px;
                  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.35); }
    .vsw-banner button { margin-left: 12px; background: #3c4043; color: #fff; border: 0;
                         border-radius: 4px; padding: 4px 10px; cursor: pointer; }`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function banner(text) {
    injectStyle();
    const el = document.createElement('div');
    el.className = 'vsw-banner';
    el.textContent = text;
    const close = document.createElement('button');
    close.textContent = '关闭';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 30000);
  }

  function deepQueryAll(selector, root = document, out = [], depth = 0) {
    if (depth > 12) return out;
    try {
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, out, depth + 1);
      }
    } catch { /* ignore */ }
    return out;
  }

  /** Calendars label days by number, so match the day-of-month within the right month. */
  function findDateCell(iso) {
    const day = String(Number(iso.slice(8, 10)));
    const byAttr = deepQueryAll(
      `[data-date="${iso}"], [data-value="${iso}"], [aria-label*="${iso}"], time[datetime="${iso}"]`);
    if (byAttr.length) return byAttr[0];

    const candidates = deepQueryAll('td, button, [role="gridcell"], [role="button"], a, span');
    return candidates.find((el) => {
      const text = (el.textContent || '').trim();
      if (text !== day) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || null;
  }

  async function run() {
    let target;
    try {
      const got = await chrome.storage.local.get('highlightTarget');
      target = got.highlightTarget;
    } catch {
      return;
    }
    if (!target || !target.date) return;
    if (Date.now() - (target.setAt || 0) > 10 * 60 * 1000) return;

    injectStyle();
    let attempts = 0;
    const timer = setInterval(() => {
      const cell = findDateCell(target.date);
      if (cell) {
        clearInterval(timer);
        cell.classList.add('vsw-hit');
        cell.scrollIntoView({ behavior: 'smooth', block: 'center' });
        banner(`找到空位：${target.date}${target.post ? '（' + target.post + '）' : ''}——请自己确认预约。`);
        chrome.storage.local.remove('highlightTarget').catch(() => {});
      } else if (++attempts > 40) {
        clearInterval(timer);
        banner(`正在找 ${target.date}${target.post ? '（' + target.post + '）' : ''}——请翻到那个月份。`);
        chrome.storage.local.remove('highlightTarget').catch(() => {});
      }
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
