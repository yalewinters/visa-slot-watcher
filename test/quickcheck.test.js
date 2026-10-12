import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Content scripts can't be ES modules, so the finder is lifted out of the real source
 * and evaluated here with its two closure dependencies injected. Testing a hand-copied
 * mirror would drift from the shipped code and quietly stop protecting anything.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'quickcheck-content.js'), 'utf8');

function extract(name) {
  const start = source.indexOf('function ' + name);
  assert.notEqual(start, -1, name + ' not found — did it get renamed?');
  // Functions in this file are indented two spaces, so "\n  }" closes them.
  const end = source.indexOf('\n  }', start) + '\n  }'.length;
  return source.slice(start, end);
}

const findPostAndOption = new Function(
  'deepQueryAll', 'isVisible',
  extract('findPostAndOption') + '\nreturn findPostAndOption;'
);

const option = (text, value) => ({ textContent: text, value });
const select = (label, options) => ({
  getAttribute: (k) => (k === 'aria-label' ? label : null),
  name: '', id: '', options
});

/** Binds the extracted function to a fake page containing these selects. */
const onPage = (selects) => findPostAndOption(() => selects, () => true);

/* Structure below mirrors the live page, confirmed by reading it:
     combobox aria-label="Consular Posts"
       option (selected, blank, no value)
       option "GUANGZHOU (广州)" value="0f6bf614-…"                                     */

test('skips the blank placeholder and selects the named post', () => {
  const page = [select('Consular Posts', [option('', ''), option('GUANGZHOU (广州)', '0f6bf614')])];
  const hit = onPage(page)('GUANGZHOU');
  assert.ok(hit, 'expected a match');
  assert.equal(hit.option.value, '0f6bf614');
});

test('waits rather than matching while only the blank option exists', () => {
  // The bug this guards: the <select> renders immediately, but the posts populate
  // afterwards. Keying on the element alone selected nothing and silently gave up.
  const page = [select('Consular Posts', [option('', '')])];
  assert.equal(onPage(page)('GUANGZHOU'), null);
});

test('matches case-insensitively and on a partial name', () => {
  const page = [select('Consular Posts', [option('', ''), option('GUANGZHOU (广州)', 'v')])];
  assert.ok(onPage(page)('guangzhou'));
  assert.ok(onPage(page)('guang'));
});

test('with no preferred post configured, takes the first real option', () => {
  const page = [select('Consular Posts', [option('', ''), option('BEIJING', 'b'), option('GUANGZHOU', 's')])];
  assert.equal(onPage(page)('').option.value, 'b');
});

test('a name that matches nothing selects nothing, never the wrong post', () => {
  const page = [select('Consular Posts', [option('', ''), option('BEIJING', 'b')])];
  assert.equal(onPage(page)('GUANGZHOU'), null);
});

test('ignores unrelated single-option dropdowns', () => {
  const page = [select('Language', [option('English', 'en')])];
  assert.equal(onPage(page)('GUANGZHOU'), null);
});

/* ---------------------------------------------------------- sign-in form */

/** The real regex, lifted from the source so the test can't drift from what ships. */
const USER_FIELD = new Function(
  'return ' + source.match(/const USER_FIELD = (\/.*\/i);/)[1]
)();

const findLoginFields = new Function(
  'deepQueryAll', 'isVisible', 'findSubmitButton', 'USER_FIELD',
  extract('findLoginFields') + '\nreturn findLoginFields;'
);

const findSubmitButton = new Function(
  'deepQueryAll', 'isVisible',
  extract('findSubmitButton') + '\nreturn findSubmitButton;'
);

const input = (attrs = {}) => ({
  tagName: 'INPUT', children: [],
  name: '', id: '', placeholder: '', autocomplete: '', value: '', form: null,
  textContent: '', ...attrs,
  getAttribute: (k) => (k === 'type' ? (attrs.type ?? 'text')
    : k === 'aria-label' ? (attrs.ariaLabel ?? null) : null)
});

const button = (text) => ({ textContent: text, value: '', getAttribute: () => null });

/**
 * Serves one fake page to the extracted finders. deepQueryAll is called with real CSS
 * selectors, so the fake dispatches on the ones those functions actually use.
 */
const query = (inputs, buttons, texts = []) => (selector) => {
  if (selector === 'input[type="password"]') {
    return inputs.filter((el) => el.getAttribute('type') === 'password');
  }
  if (selector === 'input') return inputs;
  if (selector.startsWith('button')) return buttons;
  return texts;
};

const boundLogin = (dq) =>
  findLoginFields(dq, () => true, findSubmitButton(dq, () => true), USER_FIELD);

const loginPage = (inputs, buttons = []) => boundLogin(query(inputs, buttons))();

test('a page with no password box is not a sign-in page', () => {
  assert.equal(loginPage([input({ type: 'text', name: 'search' })]), null);
});

test('picks the hinted username box, not merely the first text input', () => {
  // The sign-in page carries a site-search box above the form on some builds; taking
  // input[0] typed the email address into it and submitted nothing.
  const search = input({ type: 'text', name: 'q', placeholder: 'Search' });
  const email = input({ type: 'text', name: 'j_id0:username' });
  const pw = input({ type: 'password' });
  const found = loginPage([search, email, pw], [button('Sign In')]);
  assert.equal(found.user, email);
  assert.equal(found.password, pw);
});

test('falls back to the first text input when no field carries a hint', () => {
  // Salesforce-generated ids carry no user/email hint at all, so a strict match would
  // find the password box and nothing to put the address in.
  const opaque = input({ type: 'text', id: 'j_id0:j_id2:j_id7' });
  const pw = input({ type: 'password' });
  assert.equal(loginPage([opaque, pw]).user, opaque);
});

test('recognises an email-typed field and a Log in button', () => {
  const email = input({ type: 'email' });
  const pw = input({ type: 'password' });
  const found = loginPage([email, pw], [button('Cancel'), button('Log in')]);
  assert.equal(found.user, email);
  assert.equal(found.submit.textContent, 'Log in');
});

test('a missing submit button is reported as null, not guessed at', () => {
  // The caller falls back to form.requestSubmit(); picking an arbitrary button here
  // would click "Forgot password" on a page whose submit is an <a>.
  const found = loginPage([input({ type: 'password' })], [button('Forgot password?')]);
  assert.equal(found.submit, null);
});

/* ------------------------------------------------------ inter-action gap */

const gapMs = new Function(
  'GAP',
  extract('gapMs') + '\nreturn gapMs;'
)({ min: 700, max: 2200 });

test('the inter-action gap stays inside its configured bounds', () => {
  for (let i = 0; i < 500; i++) {
    const ms = gapMs();
    assert.ok(ms >= 700 && ms <= 2200, 'drew ' + ms + ' outside 700-2200');
  }
});

test('the gap actually varies rather than returning a constant', () => {
  const drawn = new Set(Array.from({ length: 50 }, () => gapMs()));
  assert.ok(drawn.size > 10, 'expected a spread of delays, got ' + drawn.size + ' distinct');
});

/* ------------------------------------------------- security question step */

const matchAnswer = new Function(
  'MIN_QUESTION_OVERLAP', 'normaliseQuestion',
  extract('matchAnswer') + '\nreturn matchAnswer;'
)(12, new Function(extract('normaliseQuestion') + '\nreturn normaliseQuestion;')());

const CJK_RE = new Function(
  'return ' + source.match(/const CJK_RE = (\/.*\/);/)[1]
)();

const looksLikeQuestion = new Function(
  'CJK_RE',
  extract('looksLikeQuestion') + '\nreturn looksLikeQuestion;'
)(CJK_RE);

const findSecurityQuestions = new Function(
  'deepQueryAll', 'isVisible', 'findLoginFields', 'findSubmitButton', 'QUESTION_SCAN',
  'looksLikeQuestion', 'USER_FIELD',
  extract('findSecurityQuestions') + '\nreturn findSecurityQuestions;'
);

const QUESTION_SCAN = source.match(/const QUESTION_SCAN = '([^']+)';/)[1];

const leaf = (text) => ({ tagName: 'SPAN', textContent: text, children: [], closest: () => null });

/** Same text, but inside an <a> — a "forgot password" link, never a question. */
const linkLeaf = (text) => ({
  tagName: 'SPAN', textContent: text, children: [], closest: (sel) => (/a/.test(sel) ? {} : null)
});

/**
 * `nodes` is the page in document order — inputs and text leaves interleaved, exactly as
 * the real scan sees them. Pairing depends on that order, so the fake preserves it.
 */
const questionPage = (nodes, buttons = []) => {
  const inputs = nodes.filter((n) => n.tagName === 'INPUT');
  const dq = (selector) =>
    (selector === QUESTION_SCAN ? nodes : query(inputs, buttons)(selector));
  return findSecurityQuestions(
    dq, () => true, boundLogin(dq), findSubmitButton(dq, () => true), QUESTION_SCAN,
    looksLikeQuestion, USER_FIELD
  )();
};

const SAVED = [
  { q: 'What was the name of your first pet?', a: 'Rex' },
  { q: 'In what city were you born?', a: 'Springfield' }
];

test('matches a saved question ignoring case and punctuation', () => {
  assert.equal(matchAnswer('WHAT WAS THE NAME OF YOUR FIRST PET', SAVED), 'Rex');
  assert.equal(matchAnswer('In what city were you born?', SAVED), 'Springfield');
});

test('tolerates the portal wrapping the question in extra wording', () => {
  assert.equal(
    matchAnswer('Security question: in what city were you born?', SAVED), 'Springfield');
});

test('an unsaved question yields null rather than the nearest answer', () => {
  // Answering the wrong question is how an account gets locked, so a near miss must not
  // be treated as a hit. The caller reports the question text instead.
  assert.equal(matchAnswer('What was your first car?', SAVED), null);
});

test('a short saved fragment cannot answer an unrelated question', () => {
  const sloppy = [{ q: 'pet', a: 'Rex' }];
  assert.equal(matchAnswer('What was the name of your first pet?', sloppy), null);
});

test('an entry saved with no answer is skipped, not treated as blank-correct', () => {
  assert.equal(matchAnswer('In what city were you born?', [{ q: 'In what city were you born?', a: '' }]), null);
});

test('no saved answers at all is a clean null', () => {
  assert.equal(matchAnswer('In what city were you born?', []), null);
  assert.equal(matchAnswer('In what city were you born?', undefined), null);
  assert.equal(matchAnswer('', SAVED), null);
});

test('finds the question and the answer box on a challenge page', () => {
  const box = input({ type: 'text', name: 'answer' });
  const found = questionPage(
    [leaf('Please answer your security question'), leaf('In what city were you born?'), box],
    [button('Submit')]);
  assert.ok(found, 'expected the page to read as a security question');
  assert.equal(found.steps.length, 1);
  assert.equal(found.steps[0].question, 'In what city were you born?');
  assert.equal(found.steps[0].input, box);
  assert.equal(found.submit.textContent, 'Submit');
});

test('pairs two questions with two different answer boxes', () => {
  // This portal asks two at a time. Finding "the question" and "the answer box"
  // separately took the LAST question on the page and the FIRST box — so both answers
  // went to one question and the second box was left empty.
  const first = input({ type: 'text', name: 'answer1' });
  const second = input({ type: 'text', name: 'answer2' });
  const found = questionPage([
    leaf('Answer both security questions'),
    leaf('What was the name of your first pet?'), first,
    leaf('In what city were you born?'), second
  ], [button('Continue')]);

  assert.equal(found.steps.length, 2);
  assert.equal(found.steps[0].question, 'What was the name of your first pet?');
  assert.equal(found.steps[0].input, first);
  assert.equal(found.steps[1].question, 'In what city were you born?');
  assert.equal(found.steps[1].input, second);
});

test('one question never arms two boxes', () => {
  // A confirm field or a stray input after the answer box must not be filled with the
  // same answer — a question is spent on the first box that follows it.
  const answer = input({ type: 'text', name: 'answer' });
  const stray = input({ type: 'text', name: 'other' });
  const found = questionPage([leaf('In what city were you born?'), answer, stray]);
  assert.equal(found.steps.length, 1);
  assert.equal(found.steps[0].input, answer);
});

test('a box appearing before any question is left alone', () => {
  const orphan = input({ type: 'text', name: 'first' });
  const real = input({ type: 'text', name: 'answer' });
  const found = questionPage([orphan, leaf('In what city were you born?'), real]);
  assert.equal(found.steps.length, 1);
  assert.equal(found.steps[0].input, real);
});

test('an answer box typed as password is still the question step', () => {
  // Some builds mask the answer. Without the question text this would read as a sign-in
  // form and get the account's password typed into it.
  const box = input({ type: 'password', name: 'answer' });
  const found = questionPage([leaf('What was the name of your first pet?'), box]);
  assert.ok(found);
  assert.equal(found.steps[0].input, box);
});

test('the sign-in form is never mistaken for a security question', () => {
  // The real sign-in page carries this exact link, which ends in a question mark.
  const found = questionPage([
    leaf('Forgot your security question?'),
    input({ type: 'text', name: 'username' }),
    input({ type: 'password' })
  ], [button('Sign In')]);
  assert.equal(found, null);
});

test('help text ending in a question mark is not read as the question', () => {
  const found = questionPage([leaf('Having trouble signing in?'), input({ type: 'text' })]);
  assert.equal(found, null);
});

test('a page with no question-shaped text is not a challenge page', () => {
  assert.equal(questionPage([leaf('Appointment calendar'), input({ type: 'text' })]), null);
});

/* --------------------------------------------- getting to the calendar */

const findScheduleLink = new Function(
  'deepQueryAll', 'isVisible',
  extract('findScheduleLink') + '\nreturn findScheduleLink;'
);

const link = (text, href) => ({
  textContent: text,
  getAttribute: (k) => (k === 'href' ? (href ?? null) : null)
});

const navPage = (links) => findScheduleLink(() => links, () => true)();

test('prefers an href pointing at the schedule route over any label', () => {
  // The label is localised; the route is not. A Chinese-language portal still has to work.
  const target = link('预约', '/zh-CN/schedule/');
  assert.equal(navPage([link('Home', '/'), target]), target);
});

test('falls back to the link label when nothing carries a schedule href', () => {
  // Menu items are often <button>s driving a client-side router, with no href at all.
  const target = link('Schedule Appointment', null);
  assert.equal(navPage([link('Sign Out', null), target]), target);
});

test('recognises the reschedule wording too', () => {
  const target = link('Reschedule Appointment', null);
  assert.equal(navPage([target]), target);
});

test('does not follow a link that merely mentions scheduling', () => {
  // "Scheduling policies" and "Reschedule fees apply?" are footer links, not the calendar.
  assert.equal(navPage([
    link('Scheduling policies', '/help/policies'),
    link('Rescheduling fees', '/help/fees')
  ]), null);
});

test('a page with no way to the calendar reports null rather than clicking something', () => {
  assert.equal(navPage([link('Home', '/'), link('Sign Out', '/logout')]), null);
});

/* ------------------------------------------------------ page identification */

const readPage = new Function(
  'findSecurityQuestions', 'findLoginFields', 'onCalendar', 'findScheduleLink',
  'challengeUp',
  extract('readPage') + '\nreturn readPage;'
);

const NOTHING = () => null;

/** Binds readPage to a page where only the named detector fires. */
const pageIs = (over) => readPage(
  over.question || NOTHING,
  over.login || NOTHING,
  over.calendar || (() => false),
  over.nav || NOTHING,
  Boolean(over.challenge)
)();

test('a blank page is unrecognised, not "already signed in"', () => {
  // The bug this guards: at document_idle the SPA has often rendered nothing at all.
  // Returning a page kind here made the check conclude there was nothing to sign in to,
  // skip the login form entirely, and then hunt for a Schedule link that never existed.
  // null is what makes the caller keep waiting.
  assert.equal(pageIs({}), null);
});

test('the security question wins over a sign-in form on the same page', () => {
  // A masked answer box looks exactly like a password field. Deciding "login" first would
  // type the account password into the security answer.
  const step = { steps: [{ question: 'In what city were you born?', input: {} }] };
  const fields = { user: {}, password: {} };
  assert.equal(pageIs({ question: () => step, login: () => fields }).kind, 'question');
});

test('a sign-in form is reported as login', () => {
  const fields = { user: {}, password: {} };
  assert.equal(pageIs({ login: () => fields }).kind, 'login');
});

test('a username box with no password box yet is the identifier step', () => {
  // Azure AD B2C, which is what this portal actually signs in through, can ask for the
  // address on one page and the password on the next. Treating that as "not a sign-in
  // page" left the check staring at a form it refused to fill.
  const fields = { user: {}, password: null, submit: {} };
  assert.equal(pageIs({ login: () => fields }).kind, 'identifier');
});

test('the calendar outranks a Schedule link that is still in the nav', () => {
  const found = pageIs({ calendar: () => true, nav: () => ({}) });
  assert.equal(found.kind, 'calendar');
});

test('a home page with only a Schedule link reads as nav', () => {
  assert.equal(pageIs({ nav: () => ({}) }).kind, 'nav');
});

/* ------------------------------------------------- submit button, second pass */

const submitOn = (labels) =>
  findSubmitButton(() => labels.map(button), () => true)();

test('matches a submit button whose label carries extra words', () => {
  // Exact-match-only returned null here, the caller fell back to requestSubmit(), and on
  // an SPA with no real <form> nothing was clicked at all — reported as a bad password.
  assert.equal(submitOn(['Sign in to your account']).textContent, 'Sign in to your account');
});

test('an exact label still wins over a longer one', () => {
  assert.equal(submitOn(['Sign in to continue', 'Sign In']).textContent, 'Sign In');
});

test('never clicks a control that abandons the form', () => {
  assert.equal(submitOn(['Cancel', 'Forgot password?', 'Reset my login']), null);
  assert.equal(submitOn(['Back to sign in']), null);
});

/* ------------------------------------------------------ request flag lifetime */

const MAX_AGE_MS = 180000;
const AUTO_MAX_AGE_MS = 420000;
const MAX_LOADS = 16;

const flagVerdict = new Function(
  'MAX_AGE_MS', 'AUTO_MAX_AGE_MS', 'MAX_LOADS',
  extract('flagVerdict') + '\nreturn flagVerdict;'
)(MAX_AGE_MS, AUTO_MAX_AGE_MS, MAX_LOADS);

const NOW = 1_700_000_000_000;

test('a manual request survives the redirect from the root to the sign-in page', () => {
  // The bug this guards, and it was total: the manual flag was consumed by whichever page
  // picked it up first. Entry is the site root, the portal redirects to sign-in on its
  // own, so the flag died on the root and the sign-in page loaded with nothing pending.
  // The extension did nothing at all on the login page — exactly what it looked like.
  const onRoot = { auto: false, setAt: NOW, loads: 1 };
  assert.equal(flagVerdict(onRoot, NOW + 1500), 'live');

  const afterRedirect = { ...onRoot, loads: 2 };
  assert.equal(flagVerdict(afterRedirect, NOW + 3000), 'live');
});

test('a manual request still expires, so a later visit cannot re-trigger it', () => {
  const stale = { auto: false, setAt: NOW, loads: 1 };
  assert.equal(flagVerdict(stale, NOW + MAX_AGE_MS + 1), 'expired');
});

test('an automatic request gets longer, because it crosses a sign-in chain', () => {
  const request = { auto: true, setAt: NOW, loads: 1 };
  assert.equal(flagVerdict(request, NOW + MAX_AGE_MS + 1), 'live');
  assert.equal(flagVerdict(request, NOW + AUTO_MAX_AGE_MS + 1), 'expired');
});

test('a redirect loop is bounded by the page-load count, not just by age', () => {
  // Age alone cannot stop a fast redirect loop: each hop refreshes setAt.
  const spinning = { auto: true, setAt: NOW, loads: MAX_LOADS };
  assert.equal(flagVerdict(spinning, NOW + 100), 'exhausted');
});

test('the last permitted load still runs', () => {
  const last = { auto: true, setAt: NOW, loads: MAX_LOADS - 1 };
  assert.equal(flagVerdict(last, NOW + 100), 'live');
});

test('a request with no load count yet is live', () => {
  assert.equal(flagVerdict({ auto: false, setAt: NOW }, NOW + 100), 'live');
});

test('no request at all is distinguishable from an expired one', () => {
  // The popup prints these differently: "no request pending" points at a lost flag,
  // "expired" points at a check that took too long.
  assert.equal(flagVerdict(undefined, NOW), 'none');
});

/* -------------------------------------- question wording and partial pages */

test('a question phrased without a question mark still counts', () => {
  // The case that left the second box empty: portals mix the two forms freely, and
  // requiring "?" paired the punctuated one and silently skipped the other.
  assert.ok(looksLikeQuestion('Name of your first pet'));
  assert.ok(looksLikeQuestion('City where you were born'));
  assert.ok(looksLikeQuestion('What was your first car?'));
  assert.ok(looksLikeQuestion('Your mother\u2019s maiden name'));
});

test('validation and help copy is still not a question', () => {
  assert.equal(looksLikeQuestion('This field is required'), false);
  assert.equal(looksLikeQuestion('Having trouble signing in?'), false);
  assert.equal(looksLikeQuestion('The answer you entered is incorrect'), false);
  assert.equal(looksLikeQuestion('Forgot your security question?'), false);
  assert.equal(looksLikeQuestion('Please try again'), false);
});

test('a line too short to be a question is not one', () => {
  assert.equal(looksLikeQuestion('Answer'), false);
  assert.equal(looksLikeQuestion('What?'), false);
  assert.equal(looksLikeQuestion(''), false);
});

test('pairs a mixed punctuated and unpunctuated pair of questions', () => {
  const first = input({ type: 'text', name: 'a1' });
  const second = input({ type: 'text', name: 'a2' });
  const found = questionPage([
    leaf('In what city were you born?'), first,
    leaf('Name of your first pet'), second
  ], [button('Continue')]);

  assert.equal(found.steps.length, 2);
  assert.equal(found.steps[1].question, 'Name of your first pet');
  assert.equal(found.steps[1].input, second);
});

test('counts every answer box, not only the ones it could pair', () => {
  // This count is what lets the caller refuse a partial fill. Reporting only the paired
  // boxes would make a half-read page look complete.
  const found = questionPage([
    leaf('In what city were you born?'), input({ type: 'text', name: 'a1' }),
    leaf('Security prompt'), input({ type: 'text', name: 'a2' })
  ]);
  assert.equal(found.steps.length, 1);
  assert.equal(found.boxes, 2);
});

test('a fully-read page reports matching counts', () => {
  const found = questionPage([
    leaf('In what city were you born?'), input({ type: 'text', name: 'a1' }),
    leaf('Name of your first pet'), input({ type: 'text', name: 'a2' })
  ]);
  assert.equal(found.steps.length, found.boxes);
});

test('unpunctuated noun-phrase questions are recognised by topic, not prefix', () => {
  // A prefix whitelist misses these: none of them starts with a question word, and
  // "Mother's maiden name" does not address you at all.
  assert.ok(looksLikeQuestion('Mother\u2019s maiden name'));
  assert.ok(looksLikeQuestion('Childhood best friend'));
  assert.ok(looksLikeQuestion('Make of your first car'));
  assert.ok(looksLikeQuestion('Street you grew up on'));
});

/* ----------------------------------------------- verification challenge */

test('a challenge outranks everything else on the page', () => {
  // A challenge covers whatever is underneath it. Reading the form behind one and
  // filling it is both futile and the wrong thing to do to a bot-detection control —
  // the check pauses for the person to clear it instead.
  const fields = { user: {}, password: {} };
  assert.equal(pageIs({ challenge: true, login: () => fields }).kind, 'challenge');
  assert.equal(pageIs({ challenge: true, calendar: () => true }).kind, 'challenge');
  assert.equal(
    pageIs({ challenge: true, question: () => ({ steps: [], boxes: 0 }) }).kind, 'challenge');
});

test('with no challenge up, the page reads normally again', () => {
  const fields = { user: {}, password: {} };
  assert.equal(pageIs({ challenge: false, login: () => fields }).kind, 'login');
});

/* ------------------------------------- the real "User Details" challenge page */

/*
 * Reproduced from the live page, which is why it looks the way it does:
 *
 *   User Details
 *   Username*            [applicant_demo01]
 *   Security Question 1*
 *   您的第一份工作是在哪家公司？   [ ]
 *   Security Question 2*
 *   您的第一份工作在哪个城市或地方？
 *   password is required.        [ ]
 *   [Continue] [Cancel]
 *
 * Three things here broke it at once: the username field made it read as a sign-in form,
 * the answer boxes are type=password, and the questions are Chinese with a full-width ？.
 */
const USER_DETAILS_PAGE = () => {
  const username = input({ type: 'text', name: 'username', value: 'applicant_demo01' });
  const answer1 = input({ type: 'password', name: 'answer1' });
  const answer2 = input({ type: 'password', name: 'answer2' });
  return {
    username,
    answer1,
    answer2,
    nodes: [
      leaf('User Details'),
      leaf('Username*'), username,
      leaf('Security Question 1*'), leaf('您的第一份工作是在哪家公司？'), answer1,
      leaf('Security Question 2*'), leaf('您的第一份工作在哪个城市或地方？'),
      leaf('password is required.'), answer2
    ]
  };
};

test('the live challenge page yields both questions and both boxes', () => {
  const page = USER_DETAILS_PAGE();
  const found = questionPage(page.nodes, [button('Continue'), button('Cancel')]);

  assert.ok(found, 'expected the page to read as a security-question page');
  assert.equal(found.steps.length, 2);
  assert.equal(found.boxes, 2, 'the Username field must not be counted as an answer box');
  assert.equal(found.steps[0].question, '您的第一份工作是在哪家公司？');
  assert.equal(found.steps[0].input, page.answer1);
  assert.equal(found.steps[1].question, '您的第一份工作在哪个城市或地方？');
  assert.equal(found.steps[1].input, page.answer2);
  assert.equal(found.submit.textContent, 'Continue');
});

test('the username field is never treated as an answer box', () => {
  // It sits above the questions and is type=text, so an unfiltered scan pairs question 1
  // with the username and pushes every answer one box out of place.
  const page = USER_DETAILS_PAGE();
  const found = questionPage(page.nodes);
  assert.ok(found.steps.every((s) => s.input !== page.username));
});

test('a challenge page carrying a username is not a sign-in form', () => {
  // The regression this pins: "a username box means sign-in" classified this page as a
  // login form, and the account password was typed into Security Answer 1 while the
  // second box was left empty. readPage must reach 'question' here.
  const page = USER_DETAILS_PAGE();
  const dq = (selector) => (selector === QUESTION_SCAN
    ? page.nodes
    : query(page.nodes.filter((n) => n.tagName === 'INPUT'), [button('Continue')])(selector));

  const found = readPage(
    findSecurityQuestions(dq, () => true, boundLogin(dq),
      findSubmitButton(dq, () => true), QUESTION_SCAN, looksLikeQuestion, USER_FIELD),
    boundLogin(dq), () => false, () => null, false
  )();

  assert.equal(found.kind, 'question');
});

test('Chinese questions are read with either question mark', () => {
  assert.ok(looksLikeQuestion('您的第一份工作是在哪家公司？'));
  assert.ok(looksLikeQuestion('您的第一份工作是在哪家公司?'));
  assert.ok(looksLikeQuestion('您的第一份工作在哪个城市或地方？'));
});

test('the page furniture around the questions is not mistaken for one', () => {
  assert.equal(looksLikeQuestion('Security Question 1*'), false);
  assert.equal(looksLikeQuestion('password is required.'), false);
  assert.equal(looksLikeQuestion('Username*'), false);
  assert.equal(looksLikeQuestion('User Details'), false);
});

test('a Chinese question matches its saved answer', () => {
  // Normalising with [^a-z0-9] deleted every non-ASCII character, so a Chinese question
  // became the empty string and matchAnswer bailed before comparing anything. The answer
  // would have been withheld even after the question was read correctly.
  const saved = [
    { q: '您的第一份工作是在哪家公司？', a: 'Acme' },
    { q: '您的第一份工作在哪个城市或地方？', a: 'Springfield' }
  ];
  assert.equal(matchAnswer('您的第一份工作是在哪家公司？', saved), 'Acme');
  assert.equal(matchAnswer('您的第一份工作在哪个城市或地方？', saved), 'Springfield');
});

test('the two question marks are interchangeable', () => {
  // The page renders ？ and a hand-typed Settings entry usually carries ?.
  const saved = [{ q: '您的第一份工作是在哪家公司?', a: 'Acme' }];
  assert.equal(matchAnswer('您的第一份工作是在哪家公司？', saved), 'Acme');
});

test('two Chinese questions sharing a prefix do not answer each other', () => {
  // Both begin 您的第一份工作. Answering the city question with the employer's name is
  // exactly the wrong-answer failure the overlap rule exists to prevent.
  const saved = [{ q: '您的第一份工作是在哪家公司？', a: 'Acme' }];
  assert.equal(matchAnswer('您的第一份工作在哪个城市或地方？', saved), null);
});

/* ------------------------------------------- step one: the username + password page */

/*
 * The first of the two sign-in pages. It must keep reading as `login` — the security
 * questions come on the NEXT page, and anything that makes this one look like a question
 * page types a security answer into the password box.
 */
const SIGNIN_PAGE = () => {
  const username = input({ type: 'text', name: 'username' });
  const password = input({ type: 'password', name: 'password' });
  return { username, password, nodes: [leaf('Sign In'), username, password] };
};

const classify = (nodes, buttons = []) => {
  const dq = (selector) => (selector === QUESTION_SCAN
    ? nodes
    : query(nodes.filter((n) => n.tagName === 'INPUT'), buttons)(selector));
  return readPage(
    findSecurityQuestions(dq, () => true, boundLogin(dq),
      findSubmitButton(dq, () => true), QUESTION_SCAN, looksLikeQuestion, USER_FIELD),
    boundLogin(dq), () => false, () => null, false
  )();
};

test('step one still reads as a sign-in form', () => {
  const page = SIGNIN_PAGE();
  const found = classify(page.nodes, [button('Sign In')]);
  assert.equal(found.kind, 'login');
  assert.equal(found.fields.user, page.username);
  assert.equal(found.fields.password, page.password);
});

test('a forgot-password link cannot turn step one into a question page', () => {
  // It is question-shaped text sitting right above the password box. Pairing with it
  // would type a security answer into the password field and submit it.
  for (const text of ['Forgot your password?', '忘记您的密码？', '重置您的密码？']) {
    const page = SIGNIN_PAGE();
    const nodes = [leaf('Sign In'), page.username, linkLeaf(text), page.password];
    assert.equal(classify(nodes, [button('Sign In')]).kind, 'login',
      'expected login, not question, for: ' + text);
  }
});

test('question-shaped link text is rejected even outside a link', () => {
  // Belt to the "never a link" braces: the same wording matched by the noise list, in
  // case the portal renders it as plain text on some build.
  assert.equal(looksLikeQuestion('忘记您的密码？'), false);
  assert.equal(looksLikeQuestion('重置您的密码？'), false);
  assert.equal(looksLikeQuestion('Forgot your password?'), false);
});

test('the two pages classify differently from the same detectors', () => {
  // The whole two-step flow in one assertion: page one is the password, page two is the
  // questions, and neither is mistaken for the other.
  assert.equal(classify(SIGNIN_PAGE().nodes, [button('Sign In')]).kind, 'login');
  assert.equal(classify(USER_DETAILS_PAGE().nodes, [button('Continue')]).kind, 'question');
});

/* ---------------------------------- page copy must never read as a question */

/*
 * Verbatim from the sign-in page's notice list. This one sentence, matched by nothing
 * more than the word "you", paired itself with the password box and turned the entire
 * sign-in page into a security-question page — which the extension then refused to
 * answer, blocking sign-in completely with:
 *
 *   No saved answer for: - You may not enter the U.S. with an expired visa. …
 */
const VISA_NOTICE =
  'You may not enter the U.S. with an expired visa. The visa must be valid at the ' +
  'time you enter the U.S.';

test('a notice on the sign-in page is not a security question', () => {
  assert.equal(looksLikeQuestion(VISA_NOTICE), false);
  assert.equal(looksLikeQuestion('- ' + VISA_NOTICE), false);
});

test('prose addressed to the reader is still prose', () => {
  // The rule that failed was "contains the word you". There is no generic word that
  // separates a prompt from a sentence, so nothing here may rely on one.
  assert.equal(looksLikeQuestion('Your visa allows you to travel to a U.S. port of entry'), false);
  assert.equal(looksLikeQuestion('You must bring your passport to the appointment'), false);
  assert.equal(looksLikeQuestion('Please review your details before continuing'), false);
});

test('sentence shape is rejected before wording is even considered', () => {
  assert.equal(looksLikeQuestion('The name of your first pet is required below.'), false,
    'ends in a full stop');
  assert.equal(looksLikeQuestion('• Name of your first pet'), false, 'bulleted');
  assert.equal(looksLikeQuestion(
    'Name of your first pet, which you were asked to provide when you first registered ' +
    'this account with the scheduling service'), false, 'far too long for a prompt');
});

test('the notice cannot make the sign-in page look like a questions page', () => {
  // End to end: the page still classifies as `login`, so sign-in proceeds.
  const page = SIGNIN_PAGE();
  const nodes = [leaf('Sign In'), leaf(VISA_NOTICE), page.username, page.password];
  const found = classify(nodes, [button('Sign In')]);
  assert.equal(found.kind, 'login');
  assert.equal(found.fields.password, page.password);
});

test('the real questions still survive the tightened rules', () => {
  // The tightening must not cost the case it was all built for.
  const page = USER_DETAILS_PAGE();
  const found = questionPage(page.nodes, [button('Continue')]);
  assert.equal(found.steps.length, 2);
  assert.equal(found.boxes, 2);
});

/* ------------------------------------------------- the site's virtual queue */

const QUEUE_RE = new Function(
  'return ' + source.match(/const QUEUE_RE = (\/.*\/[a-z]*);/)[1]
)();

const makeOnQueuePage = new Function(
  'document', 'QUEUE_RE',
  extract('onQueuePage') + '\nreturn onQueuePage;'
);

// document varies per case, so the closure is rebuilt each call and then invoked.
const isQueue = (text) => makeOnQueuePage({ body: { innerText: text } }, QUEUE_RE)();

test('the live waiting-room page is recognised as a queue', () => {
  // Reproduced from the page the site shows under load: a queue, not a bot-check, that
  // forwards itself onward. The check must hold rather than fail on it.
  const page = [
    'You are now in line.',
    'Thank you for your patience.',
    'Your estimated wait time is 3 minutes.',
    'We are experiencing a high volume of traffic and using a virtual queue to limit the',
    'amount of users on the website at the same time.',
    'This page will automatically refresh, please do not close your browser.'
  ].join('\n');
  assert.equal(isQueue(page), true);
});

test('each queue phrasing on its own trips detection', () => {
  assert.equal(isQueue('You are now in line'), true);
  assert.equal(isQueue('This is a virtual queue'), true);
  assert.equal(isQueue('Estimated wait time: 5 minutes'), true);
  assert.equal(isQueue('Please wait in our waiting room'), true);
});

test('an ordinary page is not mistaken for a queue', () => {
  // A false positive would leave a real check waiting on a page that already arrived.
  assert.equal(isQueue('Select a consular post and an applicant to see available dates.'), false);
  assert.equal(isQueue('Sign in to your account to continue.'), false);
  assert.equal(isQueue(''), false);
});

/* --------------------------------------------------- automatic booking */

const cellDateISO = new Function(extract('cellDateISO') + '\nreturn cellDateISO;')();

const makeFirstMatchingDay = new Function(
  'deepQueryAll', 'cellDateISO',
  extract('firstMatchingDay') + '\nreturn firstMatchingDay;'
);
const matchingDay = (cells, range) =>
  makeFirstMatchingDay(() => cells, cellDateISO)(range);

const makeFirstBookableTime = new Function(
  'deepQueryAll', 'isVisible',
  extract('firstBookableTime') + '\nreturn firstBookableTime;'
);
const bookableTime = (radios, seats) =>
  makeFirstBookableTime(() => radios, () => true)(seats);

const makeBookingLooksValid = new Function(
  'deepQueryAll', 'document',
  extract('bookingLooksValid') + '\nreturn bookingLooksValid;'
);
const looksValid = (radios, submit, iso, range) =>
  makeBookingLooksValid(() => radios, { querySelector: () => submit })(iso, range);

// A jQuery UI datepicker day cell: enabled days carry an <a>, disabled ones do not, and
// the month is 0-based on the cell (7 = August).
const dayCell = (day, month, year) => ({
  querySelector: (sel) => (sel === 'a' ? { textContent: String(day) } : null),
  getAttribute: (k) => ({ 'data-month': String(month), 'data-year': String(year) }[k] || null)
});
const disabledCell = () => ({ querySelector: () => null, getAttribute: () => null });
const timeRadio = (slots, checked = false) => ({
  checked,
  getAttribute: (k) => (k === 'data-slots' ? String(slots) : null)
});
const AUG = { start: '2026-08-01', end: '2026-08-31' };

test('a datepicker cell resolves to its ISO date, a disabled one to null', () => {
  assert.equal(cellDateISO(dayCell(5, 7, 2026)), '2026-08-05');
  assert.equal(cellDateISO(disabledCell()), null);
});

test('auto-book picks the earliest open day inside the range', () => {
  const cells = [dayCell(20, 7, 2026), dayCell(3, 7, 2026), dayCell(28, 7, 2026)];
  assert.equal(matchingDay(cells, AUG).iso, '2026-08-03');
});

test('auto-book ignores an open day outside the range', () => {
  // A September opening must never be booked when the range ends in August.
  assert.equal(matchingDay([dayCell(3, 8, 2026)], AUG), null);
});

test('auto-book takes the first time with enough seats, skipping full ones', () => {
  const radios = [timeRadio(0), timeRadio(1), timeRadio(3)];
  assert.equal(bookableTime(radios, 1), radios[1]);
});

test('auto-book needs a seat for every applicant', () => {
  assert.equal(bookableTime([timeRadio(1)], 2), null);
});

test('the pre-submit gate blocks an out-of-range day', () => {
  assert.equal(looksValid([timeRadio(3, true)], { disabled: false }, '2026-09-05', AUG), false);
});

test('the pre-submit gate blocks when no time is checked', () => {
  assert.equal(looksValid([timeRadio(3, false)], { disabled: false }, '2026-08-10', AUG), false);
});

test('the pre-submit gate blocks while the portal keeps Submit disabled', () => {
  // The portal only enables Submit once its own validation passes; a disabled button means
  // it is not satisfied, so neither are we.
  assert.equal(looksValid([timeRadio(3, true)], { disabled: true }, '2026-08-10', AUG), false);
});

test('the pre-submit gate allows only when day, time and button all agree', () => {
  assert.equal(looksValid([timeRadio(3, true)], { disabled: false }, '2026-08-10', AUG), true);
});
