/**
 * Drives one check on the schedule page: sign in if the portal has signed you out,
 * get to the calendar, select the consular post and the applicant.
 *
 * It runs only when the service worker has just set a one-shot request flag — on a
 * "Check now" click or an automatic-check alarm. No flag, no
 * interaction. That flag is the whole safeguard, and it is why an ordinary visit to the
 * portal never touches anything.
 *
 * Every step is separated by a randomised pause (see GAP). The reason is mechanical: the
 * schedule page renders its dropdown before populating it and the calendar resolves
 * asynchronously afterwards, so acting on the DOM the instant it appears selects a blank
 * option. A spread rather than a fixed delay also keeps the automatic cycle off a fixed
 * cadence.
 */
(() => {
  'use strict';

  const FLAG = 'quickCheckRequest';

  /*
   * How long a request stays live, and how far it may travel.
   *
   * Sizing these for an OAuth round trip rather than a same-site check: the portal signs
   * in through Azure AD B2C on a different domain, so one sign-in is root → /authorize →
   * one or more B2C pages → a form POST back to /signin-aad-b2c_1 → the portal home →
   * the calendar. That is a lot of page loads and, with a randomised pause between every
   * action, a lot of seconds. The old sixty-second manual budget expired somewhere in the
   * middle of it.
   */
  const MAX_AGE_MS = 180000;        // manual: still short enough not to fire on a later visit
  const AUTO_MAX_AGE_MS = 420000;   // automatic
  const MAX_HOPS = 12;              // navigations one check may make deliberately (a challenge
                                    // wait is a user pause, not one of these — see carry)
  const MAX_LOADS = 24;             // page loads one request may survive, redirects included
  const MAX_SELECTS = 3;            // times to click through to the calendar before concluding
                                    // the portal is bouncing us home (its throttle), not routing
  const DEADLINE_MS = 20000;
  const LOGIN_DEADLINE_MS = 25000;
  const NAV_DEADLINE_MS = 20000;    // finding, then following, the app's Schedule link
  const SETTLE_DEADLINE_MS = 25000; // how long the SPA gets to render something readable
  const CHALLENGE_DEADLINE_MS = 180000; // how long to wait for YOU to clear a verification
  const BOOK_DAYS_DEADLINE_MS = 15000;   // for the calendar's green days to render
  const BOOK_TIMES_DEADLINE_MS = 15000;  // for a day's time slots to load after it is picked
  const MAX_SIGNIN_STEPS = 6;       // identifier, password, question sets, and slack

  /**
   * How much of a security question must overlap a saved one before its answer is used.
   *
   * A wrong answer is worse than no answer — enough of them locks the account — so the
   * match is deliberately conservative: identical after normalising, or one contains the
   * other and the shorter is at least this long. Real questions run well past it
   * ("what was the name of your first pet"), while a saved fragment like "pet" cannot
   * reach in and answer something it was never meant for.
   */
  const MIN_QUESTION_OVERLAP = 12;

  /**
   * Names that mark an input as the username box.
   *
   * `signin` and `logonidentifier` are here for Azure AD B2C, whose field is `signInName`
   * or `logonIdentifier` depending on the policy — neither of which contains "user",
   * "email" or "login", so the generic hints missed both and fell through to whichever
   * text input happened to come first.
   */
  const USER_FIELD = /user|e-?mail|login|signin|logonidentifier|account/i;

  /**
   * Scanned in document order to pair security questions with their answer boxes.
   *
   * Inputs and text-bearing elements have to come back from ONE query: two separate
   * queries give two lists with no way to tell which question sits above which box.
   */
  const QUESTION_SCAN = 'input, label, span, p, div, h1, h2, h3, legend, li';

  /** CJK ideographs, kana and hangul — the portal serves questions in your language. */
  const CJK_RE = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;

  /** Milliseconds between two consecutive actions, drawn per action. */
  const GAP = { min: 700, max: 2200 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The randomised inter-action delay, drawn fresh for every step. */
  function gapMs(min = GAP.min, max = GAP.max) {
    return Math.round(min + Math.random() * (max - min));
  }

  const pause = (min, max) => sleep(gapMs(min, max));

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

  const isVisible = (el) => {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  /** Polls `test` until it returns something truthy, or the deadline passes. */
  async function waitFor(test, deadlineMs) {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const got = test();
      if (got) return got;
      if (Date.now() >= until) return null;
      await sleep(300);
    }
  }

  /** Frameworks listen for change events, not property writes. */
  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function applyOption(select, option) {
    setNativeValue(select, option.value);
    return (option.textContent || '').trim();
  }

  /**
   * Finds the post dropdown AND the option to pick, together.
   *
   * Waiting only for the <select> to exist is not enough: it renders immediately with a
   * single blank option, and the real posts populate afterwards. Requiring a usable
   * option is what makes this wait for the data rather than the element.
   */
  function findPostAndOption(wanted) {
    const want = (wanted || '').trim().toLowerCase();

    for (const sel of deepQueryAll('select').filter(isVisible)) {
      const label = (sel.getAttribute('aria-label') || '') + ' ' + (sel.name || '') +
        ' ' + (sel.id || '');
      const looksRight = /post|consular|location/i.test(label) || sel.options.length > 1;
      if (!looksRight) continue;

      const option = [...sel.options].find((o) => {
        if (!o.value) return false;                       // skip the blank placeholder
        const text = (o.textContent || '').trim().toLowerCase();
        if (!text) return false;
        return !want || text.includes(want);
      });
      if (option) return { select: sel, option };
    }
    return null;
  }

  /**
   * The applicant row. The calendar sits on "Loading..." forever until BOTH the post and
   * an applicant are selected, which is the non-obvious part of this flow.
   */
  function findApplicantRow() {
    const headings = deepQueryAll('h1, h2, h3, div, th, span')
      .filter((el) => /group members/i.test((el.textContent || '').trim()) &&
        (el.textContent || '').trim().length < 40);
    if (!headings.length) return null;

    const panel = headings[0].closest('div, section, table');
    if (!panel) return null;

    return [...panel.querySelectorAll('td, tr, li, div, span, label')]
      .filter((el) => {
        if (!isVisible(el)) return false;
        const text = (el.textContent || '').trim();
        if (!text || text.length > 60) return false;
        if (/group members/i.test(text)) return false;
        return el.children.length === 0;
      })[0] || null;
  }

  /**
   * The sign-in form, or null if this page is not one.
   *
   * A visible password box is the only reliable marker. The sign-in page shares its
   * chrome with every other page, and matching on the URL breaks the moment the redirect
   * target changes. The username box is whichever visible text input carries a
   * user/email/login hint, falling back to the first one, because that field's name is a
   * generated id on some builds and carries no hint at all.
   */
  function findLoginFields() {
    const password = deepQueryAll('input[type="password"]').filter(isVisible)[0] || null;

    const texts = deepQueryAll('input').filter((el) => {
      if (el === password || !isVisible(el)) return false;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return type === 'text' || type === 'email';
    });
    const hinted = texts.find((el) => USER_FIELD.test(
      [el.name, el.id, el.placeholder, el.autocomplete,
        el.getAttribute('aria-label')].join(' '))) || null;

    // A password box makes this a sign-in page. So does a clearly-named username box on
    // its own: identifier-first flows ask for the address on one page and the password on
    // the next, and Azure AD B2C — which is what this portal actually signs in through —
    // can be configured either way. Neither one present means it simply isn't a sign-in
    // page, and the fallback to texts[0] must not be allowed to invent one.
    if (!password && !hinted) return null;

    return { user: hinted || texts[0] || null, password, submit: findSubmitButton() };
  }

  /**
   * The button that advances a form.
   *
   * Matched on the whole label rather than a substring, because "Forgot password?" and
   * "Cancel" sit next to the real one and clicking either abandons the sign-in. A form
   * whose submit is an anchor or an unlabelled icon returns null on purpose — the caller
   * falls back to requestSubmit() rather than clicking something it guessed at.
   */
  function findSubmitButton() {
    const buttons = deepQueryAll('button, input[type="submit"]').filter(isVisible);
    const label = (el) => (el.textContent || el.value || '').trim();

    const exact = buttons.find((el) =>
      /^(sign[ -]?in|log[ -]?in|submit|continue|next|verify|confirm)$/i.test(label(el)));
    if (exact) return exact;

    // Second pass for labels like "Sign in to your account". Without it the exact match
    // returned null, the caller fell back to form.requestSubmit(), and on a single-page
    // app with no real <form> nothing happened at all — reported, misleadingly, as a
    // rejected password. Anything that abandons the form is excluded outright: clicking
    // Cancel or Forgot password is worse than returning null.
    return buttons.find((el) => {
      const text = label(el);
      if (!text || text.length > 40) return false;
      if (/cancel|forgot|reset|back|close|clear|help/i.test(text)) return false;
      return /sign[ -]?in|log[ -]?in|submit|continue|verify/i.test(text);
    }) || null;
  }

  /**
   * Lowercased, punctuation and spacing collapsed, so wording drift doesn't break a match.
   *
   * Letters and digits in ANY script, not `[^a-z0-9]`. That older form deleted every
   * non-ASCII character, so a Chinese question normalised to the empty string and could
   * never match anything — the answer would have been withheld even once the question was
   * read correctly. It also folds the full-width ？ and the ASCII ? to the same thing,
   * which is what makes a question copied from the page match one typed by hand.
   */
  function normaliseQuestion(text) {
    return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }

  /**
   * The saved answer for a security question, or null if none is confidently a match.
   *
   * Null is a perfectly good outcome — the caller stops and reports which question it
   * could not answer. Guessing is the failure mode worth designing against here, since
   * enough wrong answers locks the account.
   */
  function matchAnswer(question, answers) {
    const asked = normaliseQuestion(question);
    if (!asked) return null;

    for (const entry of answers || []) {
      const known = normaliseQuestion(entry && entry.q);
      if (!known || !entry.a) continue;
      if (known === asked) return entry.a;

      const shorter = Math.min(known.length, asked.length);
      if (shorter < MIN_QUESTION_OVERLAP) continue;
      if (asked.includes(known) || known.includes(asked)) return entry.a;
    }
    return null;
  }

  /**
   * The security-question step, or null if this page isn't one.
   *
   * Keyed on question-shaped text rather than on the input, because the answer box is a
   * bare field with nothing to distinguish it — and on some builds it is type=password,
   * which would otherwise read as a sign-in form. The sign-in form is ruled out first: it
   * carries both a username and a password box, and it tends to carry the words "Forgot
   * your security question?", which is exactly the kind of text that would otherwise be
   * mistaken for the question itself.
   */
  /**
   * Whether a line of page text is a security question.
   *
   * Requiring a literal question mark was too strict. Portals phrase these as statements
   * about as often as questions — "Name of your first pet", "City where you were born" —
   * and a set that mixes the two forms is the case that broke: the punctuated one paired,
   * the bare one did not, and the second answer box was left empty.
   *
   * Noise words are excluded explicitly rather than by punctuation, because the strings
   * that must not match are validation and help copy, which is what the length bounds and
   * this list are for.
   */
  function looksLikeQuestion(text) {
    const line = (text || '').trim();

    /*
     * A security question is a short prompt. Page copy is prose.
     *
     * The rule that broke this was "contains the word you" — which matched an ordinary
     * notice on the sign-in page, "You may not enter the U.S. with an expired visa…",
     * paired it with the password box, and turned the sign-in page into a questions page
     * the extension then refused to answer. Any test loose enough to accept prose
     * addressed to the reader will keep finding sentences like that one.
     *
     * So the shape is checked before the wording: bulleted, multi-sentence, or ending in
     * a full stop means informational copy, whatever words are in it.
     */
    const cjk = CJK_RE.test(line);
    if (line.length < (cjk ? 6 : 10) || line.length > 120) return false;
    if (/^[-–—•*·]/.test(line)) return false;          // a bullet in a notice list
    if (/[.。]$/.test(line)) return false;              // a statement, not a prompt

    // Second line of defence behind the "never a link" rule, in both languages the portal
    // serves. 忘记 = forgot, 重置 = reset, 必填 = required, 无效 = invalid, 错误 = wrong.
    if (/forgot|reset|trouble|having|help|why do|contact|required|invalid|incorrect|try again/i
      .test(line)) return false;
    if (/忘记|忘記|重置|帮助|幫助|必填|无效|無效|不正确|不正確|错误|錯誤|再试|再試/.test(line)) return false;

    // Full-width ？ is what a Chinese or Japanese page ends a question with, and an
    // ASCII-only test silently fails every one of them.
    if (/[?？¿]$/.test(line)) return true;
    if (cjk) return /[吗呢什麼么哪谁誰何幾几]/.test(line);

    if (/^(what|where|when|who|which|how)\b/i.test(line)) return true;

    /*
     * Unpunctuated English is a short noun phrase — "Mother's maiden name", "City where
     * you were born" — so it is matched by naming the small set of things these questions
     * are ever about, and capped well below the length of a sentence. Recognising them by
     * a generic word they happen to contain is what went wrong; there is no such word.
     */
    if (line.length > 60) return false;
    return /maiden name|nickname|childhood|grew up|best friend|favou?rite|first (pet|car|job|school|employer|teacher)|elementary|high school|birthplace|born|mother|father|pet'?s name/i
      .test(line);
  }

  function findSecurityQuestions() {
    /*
     * No bail-out on "this page has a username box".
     *
     * That rule was here for identifier-first sign-in, and it was wrong: this portal's
     * challenge page shows your Username above the questions, so the page was classified
     * as a sign-in form and the account password was typed into the first security
     * answer box. A username field on the page proves nothing either way.
     *
     * What separates the two is a question paired with a box, which is what this
     * function looks for, and readPage asks it first.
     */
    const steps = [];
    let pending = null;
    let boxCount = 0;

    /*
     * One ordered pass, pairing each answer box with the question directly above it.
     *
     * This portal asks two questions at a time, and finding "the question" and "the answer
     * box" separately cannot express that — it read the last question on the page, typed
     * its answer into the first box, and left the second question blank.
     *
     * Walking the document in order and letting a question-shaped line arm the next answer
     * box is what keeps two questions paired with two different answers. It also needs no
     * label/for wiring, which the page does not reliably have.
     */
    for (const el of deepQueryAll(QUESTION_SCAN)) {
      if (!isVisible(el)) continue;

      if ((el.tagName || '').toLowerCase() === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type !== 'text' && type !== 'password') continue;

        // The account's own Username sits on this page, above the questions. It is not an
        // answer box: pairing a question with it would put a security answer where the
        // username belongs and leave a real answer box empty.
        if (USER_FIELD.test([el.name, el.id, el.placeholder, el.autocomplete,
          el.getAttribute('aria-label')].join(' '))) continue;

        boxCount++;
        if (pending) {
          steps.push({ input: el, question: pending });
          pending = null;                  // one question answers one box, never two
        }
        continue;
      }

      if (el.children.length) continue;                          // leaf text only

      // A question is never a link. "Forgot your password?" always is — in every
      // language — which is a far better exclusion than trying to list the wording, and
      // it is what stops the sign-in page's own link from arming the password box and
      // turning step one into a security answer.
      if (el.closest && el.closest('a, button')) continue;

      const text = (el.textContent || '').trim();
      if (looksLikeQuestion(text)) pending = text;
    }

    if (!steps.length) return null;

    // `boxes` is what makes a partly-readable page detectable. If the page has two answer
    // boxes and only one question could be read, filling what we have and submitting
    // would spend a failed attempt against the account — so the caller compares these two
    // numbers and refuses rather than half-filling the form.
    return { steps, boxes: boxCount, submit: findSubmitButton() };
  }

  /**
   * The link that takes the app to the appointment calendar.
   *
   * The check enters at the site root and clicks through, rather than loading
   * /en-US/schedule/ directly — the portal is a single-page app that boots from the root,
   * and the deep link does not reliably come up. An href pointing at the schedule route
   * wins over label text, since the label is localised and the route is not.
   */
  function findScheduleLink() {
    const links = deepQueryAll('a, button, [role="menuitem"], [role="link"]')
      .filter(isVisible);

    const byHref = links.find((el) => /\/schedule\b/i.test(el.getAttribute('href') || ''));
    if (byHref) return byHref;

    return links.find((el) => {
      const text = (el.textContent || '').trim();
      if (!text || text.length > 40) return false;
      return /^(re)?schedule( an?)?( new)?( appointment)?$/i.test(text);
    }) || null;
  }

  /**
   * A virtual-queue / waiting-room interstitial — the site holding you in line under load.
   *
   * It is not a bot-check and not a refusal: nothing is asked of you, and the page forwards
   * itself to the real one once your turn comes. So it must never be read as a failure. The
   * phrases are the ones these pages announce with; a strong queue-specific one is required
   * so an ordinary page that merely mentions "traffic" or "refresh" is not mistaken for it.
   */
  const QUEUE_RE = /you\s*are\s*(now\s*)?in\s*line|virtual\s*queue|estimated\s*wait\s*time|your\s*(place|turn)\s*in\s*(the\s*)?line|waiting\s*room|you\s*are\s*visitor\s*number|waiting\s*to\s*enter/i;

  function onQueuePage() {
    const text = (document.body ? document.body.innerText || '' : '').slice(0, 20000);
    return QUEUE_RE.test(text);
  }

  /**
   * A rate-limit page — Cloudflare's "error 1015 / you are being rate limited", or a plain
   * "too many requests". Like the queue, it is waited out rather than failed on.
   */
  const RATE_PAGE_RE = /you\s*are\s*being\s*rate\s*limited|too\s*many\s*requests|error\s*1015/i;

  /**
   * The portal's own maintenance page ("Website under maintenance" / "Scheduled Website
   * Outage"). Its notice is mostly an image, so the title is what identifies it.
   */
  const MAINT_RE = /under\s*maintenance|website\s*outage|scheduled\s*(site\s*)?outage|site\s*maintenance|系统维护|网站维护/i;

  function onMaintenancePage() {
    const text = document.title + ' ' +
      (document.body ? document.body.innerText || '' : '').slice(0, 3000);
    return MAINT_RE.test(text);
  }

  /** Ends this round on a maintenance page. Reported from the top frame only. */
  async function reportMaintenance() {
    await clearFlag();
    if (window.top !== window) return;
    tell('MAINTENANCE', document.title || '');
    banner('预约网站正在维护——这一轮检查结束，稍后自动再试。', 'bad');
  }

  function onRateLimitPage() {
    const text = (document.body ? document.body.innerText || '' : '').slice(0, 5000);
    return RATE_PAGE_RE.test(text);
  }

  const onSchedulePage = () => /\/schedule/i.test(location.pathname);

  /**
   * Whether the calendar is up.
   *
   * Client-side routing does not always move the path, so a labelled post dropdown counts
   * too. The label is checked rather than merely counting <select> elements, because a
   * language picker on the home page would otherwise read as "arrived".
   */
  const onCalendar = () => onSchedulePage() ||
    deepQueryAll('select').filter(isVisible).some((sel) => /post|consular|location/i
      .test((sel.getAttribute('aria-label') || '') + ' ' + (sel.name || '') +
        ' ' + (sel.id || '')));

  function banner(text, tone) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', zIndex: 2147483647, top: '12px', left: '50%',
      transform: 'translateX(-50%)', padding: '10px 16px', borderRadius: '8px',
      font: '13px/1.5 system-ui, sans-serif', color: '#fff',
      background: tone === 'bad' ? '#d93025' : '#202124',
      boxShadow: '0 4px 16px rgba(0,0,0,.35)'
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
    // Every banner also goes to the activity log, so what the check said on the page is
    // still readable after the banner is gone (or when the tab was in the background).
    chrome.runtime.sendMessage({ type: 'LOG', text, level: tone === 'bad' ? 'warn' : 'info' },
      () => void chrome.runtime.lastError);
  }

  const tell = (type, detail) =>
    chrome.runtime.sendMessage({ type, detail }, () => void chrome.runtime.lastError);

  /**
   * Records what a sign-in step saw, for the popup's diagnostics panel.
   *
   * "It isn't logging in" is otherwise unanswerable: the failure happens on a page nobody
   * is watching, in a tab that may not even be in front. Presence and counts only —
   * never an address, a password or an answer.
   */
  const trace = (entry) => chrome.runtime.sendMessage(
    { type: 'SIGNIN_TRACE', entry: { at: Date.now(), path: location.pathname, ...entry } },
    () => void chrome.runtime.lastError);

  /* ------------------------------------------------------- the request flag */

  const clearFlag = () => chrome.storage.local.remove(FLAG).catch(() => {});

  /* ----------------------------------------------------- verification state */

  /*
   * Whether a human-verification challenge is up, mirrored from the worker's state.
   *
   * Read rather than re-detected: challenge-content.js already owns that decision and
   * maintains it through mutations and view swaps. A second copy of the pattern here
   * would be a second thing to keep right.
   *
   * Nothing in this file ever clicks a challenge. It waits for you to, and carries on.
   */
  let challengeUp = false;

  chrome.storage.local.get('state')
    .then((got) => { challengeUp = (got.state || {}).status === 'challenge'; })
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.state) {
      challengeUp = (changes.state.newValue || {}).status === 'challenge';
    }
  });

  /**
   * Whether a stored request is still live on this page load.
   *
   * A manual check used to consume its flag the moment any page picked it up, so that a
   * reload could not re-trigger it. Once entry moved to the site root that became fatal:
   * the portal redirects to sign-in on its own, the flag was spent on the root page, and
   * the sign-in page loaded with nothing pending — the check did nothing there at all.
   *
   * So the flag now survives page loads, and three bounds replace that single-use rule:
   * age, the deliberate-navigation count (MAX_HOPS, applied in carry), and the page-load
   * count here — which is the only one that covers redirects nobody asked for.
   */
  function flagVerdict(request, now) {
    if (!request) return 'none';
    const maxAge = request.auto ? AUTO_MAX_AGE_MS : MAX_AGE_MS;
    if (now - (request.setAt || 0) > maxAge) return 'expired';
    if ((request.loads || 0) + 1 > MAX_LOADS) return 'exhausted';
    return 'live';
  }

  /**
   * Hands the flag forward across a navigation this check is about to make.
   *
   * A manual check consumes its flag before acting, so a reload can never re-trigger it.
   * An automatic check may have to cross a sign-in redirect before it reaches the
   * calendar, so it carries the flag instead — bounded by MAX_HOPS, which is what stops a
   * redirect loop from turning into a navigation loop.
   *
   * `countsAsHop` is false for a challenge wait: that is the portal and you, not a
   * navigation the check chose to make, so it must not spend the navigation budget meant
   * for the sign-in steps. It still refreshes the flag (and its age) across the reload the
   * challenge causes; MAX_LOADS and the age cap remain the bounds that end a stuck one.
   */
  async function carry(request, patch, { countsAsHop = true } = {}) {
    const hops = (request.hops || 0) + (countsAsHop ? 1 : 0);
    if (hops > MAX_HOPS) {
      await clearFlag();
      tell('AUTO_FAILED', '跳转了 ' + MAX_HOPS + ' 次仍没到日历页面，放弃本次检查');
      return null;
    }
    const next = { ...request, ...patch, hops, setAt: Date.now() };
    await chrome.storage.local.set({ [FLAG]: next });
    return next;
  }

  /* -------------------------------------------------------------- the steps */

  /**
   * Gives up on the sign-in, saying why, without leaving a flag behind to re-fire.
   *
   * Only an automatic check reports to the worker. A manual one already has the person
   * looking at the page the banner is on; telling them their automatic checks are backing
   * off, when they have none, is noise.
   */
  async function abandon(request, kind, why, shown) {
    await clearFlag();
    if (request.auto) tell(kind, why);
    banner(shown || why, 'bad');
    return 'stop';
  }

  async function submitAndWait(fields, gone) {
    const form = fields.input.form;
    const how = fields.submit ? 'click'
      : (form && form.requestSubmit) ? 'requestSubmit'
        : 'nothing-to-click';
    trace({ page: 'submit', how });

    if (how === 'click') fields.submit.click();
    else if (how === 'requestSubmit') form.requestSubmit();

    // Usually the page navigates and this context is destroyed mid-wait, and the carried
    // flag is what picks the check up again on the next page. If the portal advances
    // without a navigation, the wait returns and the caller re-evaluates in place.
    await waitFor(gone, LOGIN_DEADLINE_MS);
    return gone();
  }

  async function enterPassword(request, fields, creds) {
    if (!creds.password) {
      return abandon(request, 'AUTO_NEEDS_LOGIN', '已被登出，且没有保存密码',
        '预约网站已将你登出，且没有保存密码。');
    }

    // Carry the flag BEFORE submitting: the form navigates, this context dies, and the
    // flag is all the next page has to know a check is in progress.
    if (!(await carry(request, { stage: 'login' }))) return 'stop';

    await pause();
    if (fields.user && creds.email) {
      setNativeValue(fields.user, creds.email);
      await pause();
    }
    setNativeValue(fields.password, creds.password);
    await pause();

    /*
     * "Did step one go through?" is not "is there no login form any more".
     *
     * Sign-in here is two pages: username and password, then a User Details page carrying
     * your Username and two security answer boxes. Those answer boxes are type=password,
     * so findLoginFields still matches on the second page — and testing for its absence
     * reported a perfectly good sign-in as a rejected password. What actually settles it
     * is whether the box we just filled is still the one on screen.
     */
    const filled = fields.password;
    const advanced = await submitAndWait(
      { submit: fields.submit, input: fields.password },
      () => {
        if (findSecurityQuestions()) return true;      // arrived at the questions page
        const now = findLoginFields();
        return !now || now.password !== filled;
      });
    if (!advanced) {
      return abandon(request, 'AUTO_FAILED', '登录没有成功——请检查保存的密码',
        '登录没有成功。');
    }
    return 'again';
  }

  /**
   * The address-only first page of an identifier-first sign-in.
   *
   * Submitting it reveals the password box — sometimes on a new page, sometimes in place
   * on the same one — so "advanced" means the password box exists now, not that the form
   * went away.
   */
  async function enterIdentifier(request, fields, creds) {
    if (!creds.email) {
      return abandon(request, 'AUTO_NEEDS_LOGIN',
        '登录页要求填写邮箱，但没有保存邮箱',
        '没有保存邮箱——请自己登录。');
    }

    if (!(await carry(request, { stage: 'identifier' }))) return 'stop';

    await pause();
    setNativeValue(fields.user, creds.email);
    await pause();

    const advanced = await submitAndWait(
      { submit: fields.submit, input: fields.user },
      () => {
        const now = findLoginFields();
        return !now || Boolean(now.password);
      });
    if (!advanced) {
      return abandon(request, 'AUTO_FAILED',
        '登录页一直没有要求输入密码——请检查保存的邮箱',
        '登录卡在了邮箱这一步。');
    }
    return 'again';
  }

  /** Identifies a set of questions, so "did the page move on?" is answerable. */
  const questionKey = (found) => found.steps.map((s) => s.question).join(' ~ ');

  async function answerQuestions(request, found, creds) {
    // Resolve every answer BEFORE typing any of them. This portal asks two questions at
    // once, and filling the first then discovering the second is unsaved would submit a
    // half-complete form — which spends a failed attempt against the account for no
    // reason. Nothing is typed unless the whole set can be answered.
    // More answer boxes than questions read means the page is only partly understood.
    // Filling the ones we matched and submitting leaves a box empty, which the portal
    // counts as a failed attempt — so this stops, and the trace above records both the
    // count and the questions it did read so the gap is visible.
    if (found.boxes > found.steps.length) {
      return abandon(request, 'AUTO_FAILED',
        '页面上有 ' + found.boxes + ' 个安全问题，只读出了 ' + found.steps.length +
        ' 个——不填写不完整的答案',
        '只读出了 ' + found.steps.length + ' / ' + found.boxes +
        ' 个安全问题——请自己回答。');
    }

    const resolved = [];
    for (const step of found.steps) {
      const answer = matchAnswer(step.question, creds.answers);
      if (!answer) {
        // Quote the question verbatim: it is the one piece of information needed to fix
        // this, and paraphrasing it would make the settings entry fail to match too.
        return abandon(request, 'AUTO_NEEDS_LOGIN',
          '这个安全问题没有保存答案：' + step.question,
          '没有保存答案：' + step.question);
      }
      resolved.push({ input: step.input, answer });
    }

    if (!(await carry(request, { stage: 'question' }))) return 'stop';

    for (const step of resolved) {
      await pause();
      setNativeValue(step.input, step.answer);
    }
    await pause();

    const answered = questionKey(found);
    const advanced = await submitAndWait(
      { submit: found.submit, input: resolved[0].input },
      () => {
        const now = findSecurityQuestions();
        // Either the questions are gone, or the page has moved on to a different set.
        // Requiring them to be gone outright reported the second page of a two-page
        // challenge as a rejected answer.
        return !now || questionKey(now) !== answered;
      });

    if (!advanced) {
      return abandon(request, 'AUTO_FAILED',
        '安全问题没有通过——请检查保存的答案',
        '安全问题的答案没有被接受。');
    }
    return 'again';
  }

  /**
   * What this page is, or null if it never became anything recognisable.
   *
   * The portal is a single-page app. At document_idle the body is routinely still empty
   * and the sign-in form paints a second or two later — so deciding immediately is how a
   * check concludes "nothing to sign in to" on a blank page, then spends twenty seconds
   * hunting for a Schedule link that was never there. Every decision waits for the page
   * to settle into one of the four things it can be.
   *
   * The security question is tested before the sign-in form because on some builds the
   * answer box is type=password, which would otherwise read as a sign-in form and get the
   * account password typed into it.
   */
  function readPage() {
    // Before anything else: a challenge covers whatever is underneath it, so the form it
    // hides must not be read, filled, or given up on.
    if (challengeUp) return { kind: 'challenge' };

    const step = findSecurityQuestions();
    if (step) return { kind: 'question', step };

    const fields = findLoginFields();
    if (fields && fields.password) return { kind: 'login', fields };
    if (fields && fields.user) return { kind: 'identifier', fields };

    if (onCalendar()) return { kind: 'calendar' };
    if (findScheduleLink()) return { kind: 'nav' };
    return null;
  }

  const identifyPage = () => waitFor(readPage, SETTLE_DEADLINE_MS);

  /**
   * Advances one step of the sign-in flow on whatever page this is.
   *
   * Returns 'in' (nothing to sign in to here), 'again' (a step completed without a
   * navigation, so re-evaluate) or 'stop' (cannot proceed; already reported). There is no
   * "navigating" outcome because a navigation destroys this context outright — the
   * carried flag is what resumes the check on the next page.
   */
  async function advanceSignIn(request) {
    const got = await chrome.storage.local.get(['settings', 'creds']);
    // Signing in is part of automatic checking: on whenever it is, off otherwise.
    const autoLogin = Boolean((got.settings || {}).autoCheck);
    const creds = { email: '', password: '', answers: [], ...(got.creds || {}) };

    const found = await identifyPage();

    /*
     * Presence and counts, plus the security questions verbatim.
     *
     * The questions are the one thing here that is safe to record and useless to withhold:
     * they are generic prompts, not secrets, and you have to copy them into Settings
     * word for word anyway. Answers, addresses and passwords are still never recorded.
     */
    const step = found && found.step;
    trace({
      page: found ? found.kind : 'unrecognised',
      usernameBox: Boolean(found && found.fields && found.fields.user),
      submitButton: Boolean(found && (found.fields || step || {}).submit),
      autoLogin,
      savedPassword: Boolean(creds.password),
      savedAnswers: (creds.answers || []).length,
      answerBoxes: step ? step.boxes : undefined,
      questions: step ? step.steps.map((s) => s.question) : undefined
    });

    if (!found) {
      /*
       * Quiet, and crucially without clearing the flag.
       *
       * This script runs in every frame, and most frames on this portal are chrome rather
       * than content — a frame that recognises nothing is far more likely to be the wrong
       * frame than a broken check. Clearing here would let an empty wrapper frame cancel
       * the request out from under the frame that does hold the sign-in form. The flag's
       * age and load bounds are what end a check that genuinely found nothing anywhere.
       */
      if (window.top === window) {
        if (onMaintenancePage()) {
          await reportMaintenance();
          return 'stop';
        }
        tell('AUTO_FAILED',
          '页面上没有可识别的内容——找不到登录表单、日历或预约链接' +
          (document.title ? '（页面标题：' + document.title.slice(0, 60) + '）' : ''));
      }
      return 'quiet';
    }
    /*
     * A challenge is not a failure and not a stopping point — it is a pause.
     *
     * The extension does not click these. That control exists to tell a person from a
     * script, and having the script click it is defeating it, whatever the intent. So the
     * check waits for YOU to clear it and then carries straight on, which is the part
     * that can be automated honestly: one click from you, nothing else.
     *
     * The request flag is refreshed first so the wait does not outlive it, and the worker
     * has meanwhile brought the tab to the front so the challenge is in front of you.
     */
    if (found.kind === 'challenge') {
      if (!(await carry(request, { stage: 'challenge' }, { countsAsHop: false }))) return 'stop';
      banner('需要人机验证——完成后检查会自动继续。');

      const cleared = await waitFor(() => !challengeUp, CHALLENGE_DEADLINE_MS);
      if (!cleared) return 'quiet';        // flag left to expire; the next cycle retries
      await pause();
      return 'again';
    }

    const SIGNIN_STEPS = ['login', 'identifier', 'question'];
    if (!SIGNIN_STEPS.includes(found.kind)) return 'in';

    // With automatic checking on, saved credentials are used on a "Check now" too. With it
    // off, a signed-out check does nothing further — sign in yourself.
    if (!autoLogin) {
      return abandon(request, 'AUTO_NEEDS_LOGIN',
        '预约网站已将你登出，且自动检查未开启',
        '预约网站已将你登出——请自己登录。');
    }

    if (found.kind === 'question') return answerQuestions(request, found.step, creds);
    if (found.kind === 'identifier') return enterIdentifier(request, found.fields, creds);
    return enterPassword(request, found.fields, creds);
  }

  async function selectPost(request) {
    // Wait for the dropdown to be populated, not merely present.
    const found = await waitFor(() => findPostAndOption(request.post), DEADLINE_MS);

    if (!found) {
      const anySelect = deepQueryAll('select').filter(isVisible).length;
      const why = anySelect
        ? '找不到匹配的领馆'
        : '找不到领馆下拉框';
      banner(why + '——请自己选择。', 'bad');
      if (request.auto) tell('AUTO_FAILED', why);
      return;
    }

    const chosen = applyOption(found.select, found.option);
    await pause();

    // Selecting the post is enough on its own — the calendar resolves from that. The
    // applicant click is a best-effort nudge for layouts where a member must also be
    // picked, so a missing row is not a failure and must not be reported as one.
    const applicant = findApplicantRow();
    if (applicant) {
      try { applicant.click(); } catch { /* optional step */ }
      await pause();
    }

    banner((request.auto ? '正在自动检查 ' : '正在检查 ') + chosen +
      '……插件会报告检查结果。');
  }

  /**
   * Gets from wherever the check landed to the calendar, by clicking the app's own
   * navigation the way a person would.
   *
   * Entry is always the site root and sign-in lands on the account home page, so this is
   * the normal path, not an edge case. Nothing here assigns a URL: the portal is a
   * single-page app that boots from the root, and jumping straight to /en-US/schedule/
   * does not reliably come up.
   */
  async function reachCalendar(request) {
    if (onCalendar()) return true;

    const link = await waitFor(findScheduleLink, NAV_DEADLINE_MS);
    if (!link) {
      await abandon(request, 'AUTO_FAILED',
        '在预约网站上找不到预约（Schedule）链接',
        '找不到预约（Schedule）链接——请自己打开日历。');
      return false;
    }

    // Guard against the schedule page bouncing straight back to the home page. It does that
    // by design when the portal is throttling you ("scheduling is not possible at this time,
    // wait 1 or more hours") or when today already holds an appointment — the Schedule link
    // then reappears on the home page and we click it again, forever. Counting the attempts
    // turns that loop into one honest report instead of burning the whole navigation budget.
    // A very short check interval is what most often trips the throttle.
    const selects = (request.selects || 0) + 1;
    if (selects > MAX_SELECTS) {
      await abandon(request, 'AUTO_FAILED',
        '预约网站一直把检查退回首页而不是日历——很可能在限制打开日历的频率，'
        + '请把检查间隔调长',
        '预约网站一直退回首页——可能在限制打开日历的频率。请把检查间隔调长，或者自己打开日历。');
      return false;
    }

    // Carry the flag first: the click may be a real navigation, which destroys this
    // context before anything below runs. `selects` rides along so the count survives it.
    if (!(await carry(request, { stage: 'select', selects }))) return false;

    await pause();
    try { link.click(); } catch { /* an unclickable link is handled by the wait below */ }

    // Client-side routing keeps this context alive, so the wait resolves here. A real
    // navigation kills it instead, and the carried flag resumes the check on the next
    // page — which is why a timeout is not reported as a failure.
    return Boolean(await waitFor(onCalendar, NAV_DEADLINE_MS));
  }

  /**
   * Holds through the site's virtual queue or a rate-limit page instead of failing on it.
   *
   * Either page may forward itself on, so the only job here is to survive its refreshes
   * with the request still live and then get out of the way. The age and load budgets
   * exist to bound the CHECK's own navigations, not a wait the site imposes — so they are
   * reset on each sighting. How long the wait may last is the worker's call (the "wait
   * limit" setting): when it runs out, the worker reruns the check from the start.
   *
   * Nothing here reloads the page or clicks anything.
   */
  async function holdForSite(request, kind) {
    await chrome.storage.local.set({
      [FLAG]: { ...request, setAt: Date.now(), loads: 0 }
    });
    if (kind === 'queue') {
      tell('QUEUE_SEEN', '正在网站排队');
      banner('正在网站排队——排到后会自动继续。');
    } else {
      tell('RATE_LIMITED', '被预约网站限流——等待中');
      banner('被限流了——正在等待；超过等待上限还没恢复就会重新检查。');
    }
  }

  /* ----------------------------------------------------- automatic booking */

  /**
   * today..+6 months unless the user narrowed it — mirrors resolveRange() in lib/match.js,
   * inlined because a content script cannot import the module.
   */
  function resolveRangeLocal(settings) {
    const pad = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const today = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const start = settings.rangeStart && settings.rangeStart > today ? settings.rangeStart : today;
    let end = settings.rangeEnd;
    if (!end) {
      end = new Date(Date.UTC(d.getFullYear(), d.getMonth() + 6, d.getDate()))
        .toISOString().slice(0, 10);
    }
    return { start, end };
  }

  /**
   * The ISO date a jQuery UI datepicker cell stands for, or null if it isn't a real,
   * selectable day. Only enabled days carry an <a>; disabled ones hold a bare <span>, so a
   * missing anchor is exactly how an unavailable day is rejected. The month is 0-based on
   * the cell, matching jQuery UI.
   */
  function cellDateISO(td) {
    const a = td.querySelector('a');
    if (!a) return null;
    const day = parseInt((a.textContent || '').trim(), 10);
    const month = parseInt(td.getAttribute('data-month'), 10);
    const year = parseInt(td.getAttribute('data-year'), 10);
    if (!day || Number.isNaN(month) || Number.isNaN(year)) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return year + '-' + pad(month + 1) + '-' + pad(day);
  }

  /** The earliest open ('greenday', selectable) calendar day inside the range, or null. */
  function firstMatchingDay(range) {
    return deepQueryAll('#datepicker td.greenday')
      .map((td) => ({ td, iso: cellDateISO(td) }))
      .filter((x) => x.iso && x.iso >= range.start && x.iso <= range.end)
      .sort((a, b) => a.iso.localeCompare(b.iso))[0] || null;
  }

  /** How many people this booking is for — the calendar needs a seat for each. */
  const applicantCount = () => {
    const n = deepQueryAll('#gm_select .list-group-item').filter(isVisible).length;
    return n || 1;
  };

  /** The first time slot on the selected day with room for everyone, or null. */
  function firstBookableTime(seatsNeeded) {
    return deepQueryAll('#time_select input[type="radio"][name="schedule-entries"]')
      .filter(isVisible)
      .find((r) => (parseInt(r.getAttribute('data-slots'), 10) || 0) >= seatsNeeded) || null;
  }

  /**
   * The last gate before an irreversible submit. Everything must still hold on the live
   * page: the day we chose is inside the range, a time is actually checked, and the portal
   * itself has enabled its Submit button (it only does so once its own validation passes).
   * Anything short of all three and the booking is abandoned, not guessed at.
   */
  function bookingLooksValid(chosenISO, range) {
    if (!(chosenISO >= range.start && chosenISO <= range.end)) return false;
    const checked = deepQueryAll(
      '#time_select input[type="radio"][name="schedule-entries"]').filter((r) => r.checked);
    if (!checked.length) return false;
    const submit = document.querySelector('#submitbtn');
    return Boolean(submit && !submit.disabled);
  }

  /**
   * Books the earliest open slot that matches your saved conditions — and, crucially,
   * refuses to submit anything that does not.
   *
   * This is the one step that spends something you cannot get back (the portal states a
   * reschedule limit and charges a fee for a missed appointment), so every branch that
   * cannot prove the selection matches stops and hands it back to you rather than pressing
   * Submit. It also declines to run at all unless a latest date is set: without it
   * "matches my condition" is too broad to commit to on its own. A post is not required —
   * left blank, selectPost takes the dropdown's only (first) real option.
   */
  async function autoBook(request, settings) {
    if (!settings.rangeEnd) {
      banner('自动预约需要先设置最晚日期——这次请自己预约。', 'bad');
      // A note, not a failure: auto-book being unable to act must never slow the check
      // cadence. Backoff is for the portal refusing us, not for our own configuration.
      if (request.auto) {
        tell('BOOK_NOTE', '自动预约未执行：请设置能接受的最晚日期');
      }
      return;
    }

    const range = resolveRangeLocal(settings);
    const seats = applicantCount();

    const day = await waitFor(() => firstMatchingDay(range), BOOK_DAYS_DEADLINE_MS);
    if (!day) {
      // Nothing to book is a normal outcome, not a failure: the calendar simply held no
      // open day inside your dates.
      banner('你的日期范围内没有空位——没有提交任何预约。');
      return;
    }

    const anchor = day.td.querySelector('a');
    try { anchor.click(); } catch { return; }
    await pause();

    const slot = await waitFor(() => firstBookableTime(seats), BOOK_TIMES_DEADLINE_MS);
    if (!slot) {
      banner('找到了空位日期，但没有名额足够的时间段——请自己完成。', 'bad');
      return;
    }
    try { slot.click(); } catch { return; }
    await pause();

    if (!bookingLooksValid(day.iso, range)) {
      banner('无法确认所选日期在你的范围内——不提交，请自己完成。', 'bad');
      // Not a portal refusal, so it must not back off the cadence — just note it.
      if (request.auto) {
        tell('BOOK_NOTE', '自动预约在提交前停止：所选内容未通过核对');
      }
      return;
    }

    const submit = document.querySelector('#submitbtn');
    banner('正在预约 ' + day.iso + (request.post ? '（' + request.post + '）' : '') + '……');
    // Announce it before the click: a booking is irreversible, so you should be told one
    // was submitted even if this tab is in the background and the click then navigates.
    tell('AUTO_BOOKING', '正在提交预约：' + day.iso +
      (request.post ? '（' + request.post + '）' : ''));
    try { submit.click(); } catch { /* the portal's own validation handles a stray click */ }
  }

  async function run(request) {
    await pause();

    // Sign-in can be more than one page — password, then a security question — and the
    // portal renders some of those steps in place rather than navigating. Loop until it
    // stops being a sign-in, bounded so a step that never clears cannot spin.
    for (let i = 0; i < MAX_SIGNIN_STEPS; i++) {
      const outcome = await advanceSignIn(request);
      if (outcome === 'stop') return;        // reported, and the flag is cleared
      if (outcome === 'quiet') return;       // wrong frame — leave the flag for the right one
      if (outcome === 'in') break;
    }

    if (!(await reachCalendar(request))) return;

    await clearFlag();                       // reached the calendar; the request is spent
    await selectPost(request);

    // Only when you have deliberately switched it on. Everything above only ever reads the
    // calendar; this is the one path that can submit, so it is gated on its own setting.
    const cfg = await chrome.storage.local.get('settings');
    if ((cfg.settings || {}).autoBook) await autoBook(request, cfg.settings || {});
  }

  (async () => {
    let request;
    try {
      const got = await chrome.storage.local.get(FLAG);
      request = got[FLAG];
    } catch {
      return;
    }
    if (!request) {
      // Record this only on a sign-in page. "The script ran here but no check was
      // pending" is the one observation that separates a lost request flag from a
      // content script that never loads on this page at all — and everywhere else it
      // would just be noise.
      if (deepQueryAll('input[type="password"]').filter(isVisible).length) {
        trace({ page: 'boot', hasFlag: false });
      }
      return;
    }

    const verdict = flagVerdict(request, Date.now());
    if (verdict !== 'live') {
      await clearFlag();
      if (verdict === 'exhausted') trace({ page: 'boot', hasFlag: true, gaveUp: true });
      return;
    }

    /*
     * The flag is deliberately NOT consumed here.
     *
     * It used to be, for a manual check: consume on arrival so a reload could never
     * re-trigger it. That was safe when the check opened the calendar URL directly. It is
     * not safe now that entry is the site root, because the portal redirects to sign-in on
     * its own — so the flag was consumed on the root page, the redirect fired, and the
     * login page loaded with no request pending. The check did nothing there at all,
     * which is exactly what it looked like.
     *
     * Re-firing is bounded three other ways instead: the age check above, MAX_HOPS on
     * navigations this script makes deliberately, and MAX_LOADS on page loads one request
     * may survive — which is the bound that covers redirects nobody asked for.
     */
    const loads = (request.loads || 0) + 1;
    request = { ...request, loads };
    await chrome.storage.local.set({ [FLAG]: request });

    trace({ page: 'boot', hasFlag: true, loads, auto: Boolean(request.auto) });

    if (document.readyState === 'loading') {
      await new Promise((r) => document.addEventListener('DOMContentLoaded', r, { once: true }));
    }

    // A virtual queue is a wait, not a step: hold the request open across the page's own
    // refreshes and let it forward itself to the real page, where the flow resumes. Checked
    // before run() so the queue is never mistaken for an unrecognised page and failed.
    if (onQueuePage()) {
      await holdForSite(request, 'queue');
      return;
    }
    if (onRateLimitPage()) {
      await holdForSite(request, 'rate');
      return;
    }
    if (onMaintenancePage()) {
      await reportMaintenance();
      return;
    }

    run(request).catch(() => clearFlag());
  })();
})();
