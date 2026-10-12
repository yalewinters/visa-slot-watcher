import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  triage, describeResponse, OK, EXPIRED, CHALLENGE, BLOCKED, ERROR, RATE_LIMITED
} from '../src/lib/triage.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

test('an access-limitation page is a block, even with HTTP 200', () => {
  const verdict = triage(200, fixture('blocked.html'), 'https://www.usvisascheduling.com/en-US/');
  assert.equal(verdict.kind, BLOCKED);
});

test('HTTP 403 is a block', () => {
  assert.equal(triage(403, 'Forbidden').kind, BLOCKED);
});

test('HTTP 429 is a rate limit, not a block', () => {
  assert.equal(triage(429, 'slow down').kind, RATE_LIMITED);
});

test("Cloudflare's 1015 page is a rate limit even though it is titled Access denied", () => {
  const page = '<!doctype html><html><head><title>Access denied | used Cloudflare to ' +
    'restrict access</title></head><body><h1>Error 1015</h1>' +
    '<h2>You are being rate limited</h2></body></html>';
  assert.equal(triage(403, page).kind, RATE_LIMITED);
  assert.equal(triage(200, page).kind, RATE_LIMITED);
});

test('an access-limitation notice still wins over a rate-limit phrase', () => {
  assert.equal(triage(429, '{"error":"Access limitation: too many requests"}').kind, BLOCKED);
});

test('a verification interstitial is a challenge', () => {
  const verdict = triage(200, fixture('challenge.html'));
  assert.equal(verdict.kind, CHALLENGE);
});

test('an Aura invalidSession event is an expired session', () => {
  const verdict = triage(200, fixture('invalid-session.json'));
  assert.equal(verdict.kind, EXPIRED);
});

test('a login redirect is an expired session', () => {
  const verdict = triage(200, '<form><input type="password" name="pw"></form>',
    'https://www.usvisascheduling.com/secur/login');
  assert.equal(verdict.kind, EXPIRED);
});

test('a block outranks a challenge when both strings appear', () => {
  // Block pages sometimes still carry challenge scaffolding; the block must win,
  // because treating it as a challenge would resume polling into a live block.
  const body = 'Access Limitation. Please verify you are human.';
  assert.equal(triage(200, body).kind, BLOCKED);
});

test('a good availability payload is ok', () => {
  assert.equal(triage(200, fixture('aura-availability.json')).kind, OK);
});

test('server errors and empty bodies are plain errors', () => {
  assert.equal(triage(500, 'boom').kind, ERROR);
  assert.equal(triage(200, '   ').kind, ERROR);
});

/* False-positive guards. The portal's own terms include a "Prohibited Conduct" section,
   so any page or payload quoting the terms must not be read as a block — a false block
   hard-stops the watcher and tells the user to wait 24 hours for nothing. */

test('the terms page is not mistaken for a block', () => {
  const verdict = triage(200, fixture('terms-page.html'),
    'https://www.usvisascheduling.com/en-US/terms/');
  assert.notEqual(verdict.kind, BLOCKED,
    'quoting the prohibited-conduct terms is not a block');
});

test('"prohibited conduct" alone does not condemn a 200 response', () => {
  const verdict = triage(200, 'Please review our prohibited conduct policy before booking.');
  assert.notEqual(verdict.kind, BLOCKED);
});

test('"prohibited conduct" alongside a 403 is a block', () => {
  const verdict = triage(403, 'Blocked due to violation of the prohibited conduct clause.');
  assert.equal(verdict.kind, BLOCKED);
});

test('a real access-limitation notice is still caught at HTTP 200', () => {
  assert.equal(triage(200, fixture('blocked.html')).kind, BLOCKED);
});

/* The failure that actually bit: a replay that misses the API gets the SPA shell back.
   Salesforce ships localized label bundles in that markup, so block phrases appear as
   inert label strings. Scanning the whole document reads that as a live block, while the
   portal works perfectly in the browser. */

test('label strings in an HTML shell are not a block', () => {
  const verdict = triage(200, fixture('spa-shell.html'),
    'https://www.usvisascheduling.com/en-US/');
  assert.notEqual(verdict.kind, BLOCKED,
    'an inert "Access Limitation" label must not hard-stop the watcher');
});

test('HTML where JSON was expected is reported as a misdirected replay', () => {
  const verdict = triage(200, fixture('spa-shell.html'));
  assert.equal(verdict.kind, ERROR);
  assert.match(verdict.reason, /请求没有到达接口/);
});

test('a genuine block page is still caught, because it announces itself', () => {
  // blocked.html carries "Access Limitation" in both <title> and <h1>.
  assert.equal(triage(200, fixture('blocked.html')).kind, BLOCKED);
});

test('a block phrase inside an API payload is still trusted', () => {
  const verdict = triage(200, '{"message":"Access Limitation: request refused"}');
  assert.equal(verdict.kind, BLOCKED, 'JSON has no incidental prose to confuse us');
});

test('describeResponse summarises without dumping the body', () => {
  const info = describeResponse(200, fixture('spa-shell.html'),
    'https://www.usvisascheduling.com/en-US/?x=1');
  assert.equal(info.kind, 'html');
  assert.equal(info.finalUrl, 'https://www.usvisascheduling.com/en-US/');
  assert.match(info.announced, /Visa Application Home/);
  assert.ok(info.bytes > 0);
  assert.ok(!JSON.stringify(info).includes('$Labels'), 'raw body is not included');
});

test('the current Cloudflare verification wording is detected as a challenge', () => {
  // Earlier patterns keyed on "verify you are" and missed "verifies you are not a bot",
  // so this interstitial went unnoticed and the watcher sat behind it silently.
  const verdict = triage(200, fixture('cf-verification.html'));
  assert.equal(verdict.kind, CHALLENGE);
});

test('ordinary calendar copy is not mistaken for a challenge', () => {
  const verdict = triage(200, '{"AvailableDates":[],"message":"No appointments available"}');
  assert.notEqual(verdict.kind, CHALLENGE);
});
