/**
 * Watches for human-verification challenges and reports when one clears.
 *
 * Observation only: it never clicks, answers, or otherwise interacts with a challenge.
 * Its whole job is to notice when the user has cleared one so polling can resume,
 * instead of the watcher sitting silently dead behind an interstitial.
 */
(() => {
  'use strict';

  const CHALLENGE_RE = /captcha|recaptcha|hcaptcha|are\s*you\s*(a\s*)?human|verif\w*\s*(you|your)\s*(are|is|identity)|not\s*a\s*bot|checking\s*your\s*browser|just\s*a\s*moment|performing\s*security\s*verification|security\s*service\s*to\s*protect|protect\s*against\s*malicious\s*bots|enable\s*javascript\s*and\s*cookies/i;

  // Only "access limitation", and only where the page announces it — in the title or a
  // heading. The portal's own terms contain a "Prohibited Conduct" section, so matching
  // that phrase anywhere in the body text makes any page quoting the terms look like a
  // block, and a false block hard-stops the watcher for no reason.
  const BLOCKED_RE = /access\s*limitation/i;

  let wasChallenged = false;
  let reportedClear = false;

  const tell = (type, detail) => {
    try {
      chrome.runtime.sendMessage({ type, detail, url: location.href },
        () => void chrome.runtime.lastError);
    } catch { /* extension reloaded */ }
  };

  /** Text the page uses to announce itself, as opposed to body copy it merely contains. */
  function prominentText() {
    const headings = [...document.querySelectorAll('h1, h2, [role="heading"]')]
      .slice(0, 10).map((el) => el.textContent || '').join(' ');
    return (document.title || '') + ' ' + headings;
  }

  function currentState() {
    if (BLOCKED_RE.test(prominentText())) return 'blocked';

    const text = (document.body ? document.body.innerText || '' : '').slice(0, 200000);
    if (CHALLENGE_RE.test(text)) return 'challenge';
    if (document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')) return 'challenge';
    return 'clear';
  }

  function check() {
    const state = currentState();
    if (state === 'blocked') {
      tell('PORTAL_BLOCKED', '页面显示访问受限');
      return;
    }
    if (state === 'challenge') {
      if (!wasChallenged) {
        wasChallenged = true;
        tell('CHALLENGE_SEEN', '页面出现人机验证');
      }
      return;
    }
    if (wasChallenged) {
      wasChallenged = false;
      reportedClear = true;
      tell('CHALLENGE_CLEARED', '页面已恢复正常');
      return;
    }

    // A page that loaded already-clear. Clearing a challenge usually navigates or reloads
    // to the real page, which tears down the content script that saw the challenge before
    // it can report the clear — so the worker would sit stuck in the challenge state and
    // the paused check would never resume. Reporting a clear once from a fresh load closes
    // that gap. It is harmless when no challenge was up: the worker only acts on it if the
    // tab it recorded the challenge on is this one.
    if (!reportedClear) {
      reportedClear = true;
      tell('CHALLENGE_CLEARED', '页面已恢复正常');
    }
  }

  check();
  const observer = new MutationObserver(() => check());
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  // Lightning swaps views without a navigation, so poll as a backstop.
  setInterval(check, 5000);
})();
