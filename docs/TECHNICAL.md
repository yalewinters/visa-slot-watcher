# US Visa Slot Watcher

A Chrome extension that checks **usvisascheduling.com** for appointment openings in a date
range you choose, on a timer, and tells you what it found — on your desktop and on your
phone.

It works one way: **the extension runs the check itself.** On a timer (or when you press
**Check now**) it opens the portal in a real tab, signs in if the portal has signed you
out, clicks through to the calendar, selects the consular post and your applicant, and
reads the result. Browsing the calendar yourself is ignored — only checks the extension
started are read.

---

## Read this before turning automatic checking on

**The portal's terms prohibit automated access, and the site actively fingerprints
extensions.** Automatic checking is off by default and stays off across upgrades. If the
portal starts refusing you, the account being refused is yours. That is the trade you are
making; the extension will not pretend otherwise.

What it does *not* do:

- **It doesn't forge requests.** An earlier version replayed the calendar request from the
  service worker on a timer, and Cloudflare blocked it — 403 and an `Attention Required!`
  page — while the site kept working normally in the browser. The reason is structural: a
  `fetch()` from an extension worker carries no `Origin`, no `Referer`, and reports
  `Sec-Fetch-Site: none`, which is exactly what bot management scores on. Cookies were
  never the problem; the shape of the request was. Making that request *look* like page
  traffic would be circumventing the control, so that loop was deleted. The extension
  drives the real page in a real tab instead — the requests are the page's own, because
  the page is what gets driven.
- **It doesn't answer verification challenges.** Not a limitation waiting to be
  engineered around — a scripted click is exactly the signal a Turnstile or CAPTCHA
  control exists to detect, so faking one buys a harder challenge or a block on the
  account rather than a pass. What it does instead is make the click cheap: the window
  flashes in the taskbar, a persistent notification takes you straight to the tab, **a
  sign-in already in flight pauses rather than dying** and picks up the moment you clear
  it, and a challenge does not count toward any backoff.
- **It doesn't push through a block.** An access limitation switches automatic checking
  off, and it stays off until you turn it back on. See [When the portal pushes
  back](#when-the-portal-pushes-back).
- **It doesn't book unless you tell it to.** Auto-book is a separate, off-by-default
  setting. With it off, a match gets you a notification and a link, and you do the
  booking.

## Install

1. `chrome://extensions`
2. **Developer mode** on
3. **Load unpacked** → select this folder (the one with `manifest.json`)

Confirm the popup footer shows the current version after any reload.

## Use

1. Open **Settings**: set your date range, and optionally the consular post (e.g.
   `GUANGZHOU`). Left blank, the first post in the dropdown is selected.
2. To get results on your phone, install the **ntfy** app, subscribe to a long, random
   topic name, and put the same name in Settings. **Send test to phone** checks it.
3. Turn on **Check automatically on a timer** and set an interval. Save your portal
   sign-in details if you want signed-out checks to sign back in by themselves.
4. Or press **Check now** in the popup to run one check immediately.

Each check's result shows in the popup. If a date lands in your range you get a silent
desktop notification and a badge count; clicking the notification jumps to that date on
the portal and outlines it. A given date notifies on the desktop only once, so
re-checking doesn't re-alert you.

### What reaches your phone

With an ntfy topic set, the phone gets exactly two kinds of message:

- **Every check's result**, match or not. It always lists the open dates the calendar
  showed — or says there are none:
  - `MATCH FOUND - book now!` (urgent priority) for a new date in your range, tap to open
    the portal;
  - `Check done - match still open` when the in-range date was already reported;
  - `Check done - no match` (low priority), with the open dates outside your range.
- **`检查失败`** with the reason, when a check does not produce a result: signed out,
  the portal's maintenance page, a page the check could not read, a calendar it could
  not parse — or, after 5 minutes with neither a result nor an error, "no result yet"
  (a page that never loaded, or a challenge still waiting on you).
- **`预约网站拒绝访问`** when an access limitation switches automatic checking off.
- **`预约已提交`** when auto-book submits an appointment.

So every check sends exactly one message — its result or why it failed. When the page fetches the
calendar more than once in a check, the responses are merged and pushed once (a later
one is pushed again only if it brings a new match). Nothing else is
pushed. ntfy topics are public: anyone who knows the name can read the
feed, so make it long and random.

### Automatic checking

Turn on **Check automatically on a timer** in Settings and set an interval — 10 minutes is
a reasonable starting point. The floor is 1 minute, but **intervals under 5 minutes check
the portal much harder** and make a challenge, rate limit or block more likely.

Each cycle:

1. Reuses an open portal tab, or opens one at `https://www.usvisascheduling.com/`. By
   default it stays in the **background** and does not steal focus; there is a setting if
   you want it to come forward. By default it also reloads the portal tab even if you are
   looking at it; turn **Check even when I'm using the portal tab** off to skip that cycle
   instead.
2. **Sign-in page one** — username and password. With credentials saved, it fills and
   submits them. With none saved, it stops and leaves the sign-in to you.
3. **Sign-in page two** — the *User Details* page, showing your Username and **two
   security questions**. It answers both from your saved list, or, if either is unsaved,
   types nothing and tells you the exact wording it could not answer.
4. **Clicks the app's own Schedule link** to reach the calendar. A whole check is bounded
   at twelve deliberate navigations and twenty-four page loads, so an OAuth redirect chain
   has room to complete but a redirect loop cannot spin.
5. Selects the consular post and your applicant, and reads the calendar response.
6. With **auto-book** on, books the earliest open day in your range (see below).

**Every entry point is the site root, never `/en-US/schedule/`.** The portal is a
single-page app that boots from the root, and deep-linking into the calendar does not
reliably come up. So the check enters where a person would and clicks through, preferring
a link whose `href` points at the schedule route over one matched on its label — the label
is localised, the route isn't.

**Sign-in is two pages, and telling them apart is the delicate part.** Both carry a
username field and a `type=password` box, so the obvious tests confuse them: "is there a
password box?" is true on the questions page, and "is there a username box?" is true on
both. What actually separates them is a question paired with its own answer box, which is
tested first — and a question is never inside a link, which is what keeps a
*Forgot your password?* link on page one from arming the password box.

For the same reason, "did page one go through?" is not "is the login form gone" — it
isn't, on page two. It asks whether the box that was filled is still the one on screen.

Sign-in steps are handled one page at a time, and the portal renders some of them in place
rather than navigating, so the check re-evaluates after each step instead of assuming a
page load. Whether the Schedule click is a real navigation or client-side routing is
likewise not assumed: it waits for the calendar either way.

The popup's right-hand meta line shows when the next check is due.

**Timing.** Two separate randomisations, both in `lib/jitter.js`:

- *Between checks*: the interval is drawn fresh each cycle within ± your jitter percentage
  (default 30%), so 10 minutes waits somewhere between 7 and 13. A fixed alarm lands on
  the same second of every tenth minute forever, and every retry after a transient failure
  lands in the same place too.
- *Between actions inside one check*: 0.7–2.2 s. This one is load-bearing for correctness,
  not cosmetics — the post dropdown renders before it is populated, and acting the instant
  it appears selects the blank placeholder.

By default the interval is always the one you set. Turn **Always use my exact interval**
off and each failed cycle doubles the next wait instead, up to 16× — the popup then shows
it, e.g. `Auto-check in 40 min (backed off ×4)`.

### When the portal pushes back

| What happens | What the extension does |
|---|---|
| **Signed out** | With automatic checking on and credentials saved, signs back in. Otherwise the check stops and the sign-in is left to you. |
| **Virtual queue** ("you are in line") | Waits in place — no reload, no click. If the page hasn't forwarded itself within the **wait limit** (default 10 min), the check is rerun from the start. |
| **Verification challenge** | Never answered by the extension. Checking pauses until you clear it, then carries on. Optionally reloads the challenge page once. |
| **Rate limit** (HTTP 429, "you are being rate limited", Cloudflare error 1015) | Same as the queue: waits up to the wait limit, then reruns the check. |
| **Maintenance page** ("Website under maintenance") | This round ends and a failure is pushed; no backoff, the next check runs on the normal interval. |
| **Access limitation / block** | **Automatic checking is switched off** and nothing is retried. Turn it back on in Settings once you've left the site alone for a while. |

The wait limit is shared by the queue and the rate limit, and is set in Settings (1–120
minutes). Its clock starts at the first sighting and is not reset by the page's own
refreshes.

Cloudflare's rate-limit page is titled *Access denied*; it is recognised as a rate limit
before the block checks run, so it does not switch automatic checking off. A bare HTTP 403
with nothing else to go on is still treated as a block.

### Auto-book (opt-in, irreversible)

**Book the earliest matching slot automatically** submits a real appointment booking
without asking. The portal limits how many times you may reschedule and charges a new fee
for a missed appointment, and there is no confirmation step.

It only runs when a **latest acceptable date** is set. It picks the earliest open day in
your range and the first time with enough seats for your group, and it refuses to press
Submit unless it can verify the selected date is inside your range and the time is
checked. Anything short of that is left for you to finish. A submitted booking raises a
desktop notification and a `Booking submitted` push.

### Credentials

Sign-in details are stored **unencrypted** in `chrome.storage.local`, which is a plain file
in your browser profile. Anything that can read that directory can read all of it. The
security answers deserve a second thought on that point — the same ones usually unlock the
rest of your accounts.

Leaving any of these blank is fully supported: a check that finds you signed out then
stops and leaves the sign-in to you. Saving with a field emptied deletes what was stored
in it, and **Forget saved credentials** clears the lot. The fields are only editable while
automatic checking is on, since that is the only time they are used — on the timer and on
**Check now** alike.

**Security questions.** This portal asks **two at a time** on a *User Details* page after
the password, drawn from your set with no telling which pair — so save every question it
might ask, one `question | answer` per line in Settings.

Save them **in the language the portal shows them in**. The questions are served in the
account's language (`您的第一份工作是在哪家公司？`, not "Which company was your first job
at?"), and matching compares what the page says with what you saved. Copy them from the
page. Either question mark works — the full-width `？` the page renders and the ASCII `?`
you are likely to type both normalise to the same thing.

That page also shows your **Username** above the questions. It is not an answer box and is
never filled: treating a username field as proof of a sign-in form is what made an earlier
version type the account password into Security Answer 1.

Both questions are paired with their own answer boxes by walking the page in document
order and letting each question claim the next box below it. Doing that by finding "the
question" and "the answer box" separately does not work on a two-question page: it takes
the last question and the first box, so one answer goes to the wrong question and the
other box is left empty.

A question does not have to end in a question mark to be recognised. Portals mix
`What was your first car?` with `Mother's maiden name` freely, and requiring the
punctuation paired one and silently skipped the other — leaving the second box empty.

Loosening that, though, is how the sign-in page's own notice list —
`You may not enter the U.S. with an expired visa…` — got read as a question, paired with
the password box, and blocked sign-in entirely. So **shape is checked before wording**: a
bulleted line, a line ending in a full stop, or anything longer than a short prompt is
page copy, whatever words are in it. There is no generic word (`you`, `your`) that
separates a prompt from a sentence, and nothing here relies on one — unpunctuated
questions are matched by naming the small set of things they are ever about.

Matching ignores case and punctuation and tolerates the portal wrapping extra words around
the question, but it is deliberately conservative, and it refuses in two distinct ways:

- **A question with no saved answer** stops the check and reports the exact wording to add.
- **More answer boxes on the page than questions it could read** also stops the check —
  `read 1 of 2 answer boxes` — rather than filling what it understood.

Both matter for the same reason: **every answer in a set is resolved before any of them is
typed**. A half-filled form spends a failed attempt against your account just as surely as
a wrong answer does, so nothing is entered and nothing is submitted unless the whole set
can be answered.

Saved answers are shown as dots, never in plaintext; leave a line's dots alone to keep it.

**Where sign-in actually happens.** Not on the portal. `usvisascheduling.com` federates to
**Azure AD B2C** — you are redirected to `atlasauth.b2clogin.com/…/oauth2/v2.0/authorize`,
type your password on Microsoft's page, and get POSTed back to
`www.usvisascheduling.com/signin-aad-b2c_1`. So auto sign-in requires a content script on
that host, which is why the extension asks for it and why Chrome shows a second site in
the permission prompt.

That permission is scoped to `atlasauth.b2clogin.com` — the single B2C tenant this portal
uses. It is deliberately **not** `*.b2clogin.com`, which would be every organisation's
sign-in page on Microsoft's shared domain.

Understand what you are granting: an extension with a content script on a sign-in page can
read what is typed there. That is the price of filling the form, and it is the same price
your password manager charges. Leave the credentials blank and the extension will still
check on its timer and simply stop when a sign-in is needed.

Both the identifier-first shape (address, then password on the next page) and the combined
one are handled, since B2C policies can be configured either way.

A redirect to any *other* domain remains out of reach and shows up as "signed out".

**If it isn't signing in**, open **操作记录** from the popup and expand **技术详情**. On a
security-question page the `SIGN-IN TRACE` prints the questions verbatim and how many
answer boxes were on the page:

```
  6s ago   /b2c_1a_atoproduction_atlas_susi/…
    saw: question, submit button
    saved: auto sign-in ON, password yes, answers 4
    read 1 of 2 answer boxes:
      • In what city were you born?
```

`read 1 of 2` means the second question could not be read at all — open an issue with that block.
Two lines listed and `read 2 of 2` means both were found, and any that stopped the check
is one you need to add to Settings, copied exactly as printed. The questions are recorded
because they are generic prompts you have to enter verbatim anyway; answers, addresses and
passwords never are.

The same block records what each other step saw — which kind of page,
whether a username box and a submit button were found, whether auto sign-in was on and
credentials were saved, and how the form was submitted. Presence and counts only; no
values are recorded, so the panel is safe to copy into a bug report. `saw: unrecognised`
means the page never rendered anything readable; `auto sign-in OFF` (automatic checking is
off) or `password NO` means it never got as far as trying.

## Settings

| Setting | Notes |
|---|---|
| Date range | Blank = today through six months out. A past start date is clamped to today. |
| Consular post | Optional. Matched case-insensitively as a substring of the dropdown option. Blank = the first post listed. |
| ntfy.sh topic | Blank = no phone push. Long and random — anyone who knows it can read the feed. |
| Check automatically | Opt-in. Opens the schedule page on a timer without you, and signs in when signed out. |
| Check every / vary by | Base interval (min 1, 5+ recommended) and the ± spread drawn per cycle. |
| Longest wait in the site queue or a rate limit | Default 10 minutes (1–120). Past it, the check is rerun. |
| Always use my exact interval | On by default. Off = each failed cycle doubles the wait, up to 16×. |
| Bring the tab to the front | Off by default; automatic checks run in a background tab. |
| Check even when I'm using the portal tab | On by default. Off = skip the cycle rather than reload the tab you're on. |
| Reload once on a challenge | On by default. Reloads the challenge page a single time; you still clear it. |
| Book automatically | Off by default. Irreversible; requires a latest acceptable date. |
| Email / password | Used to sign back in. Stored unencrypted. |
| Security questions | `question \| answer`, one per line. No confident match stops the check rather than guessing. |

---

## How it works

```
capture-main.js       MAIN world — observes fetch/XHR, forwards availability responses
capture-content.js    isolated world — nonce-validates and relays to the worker
background.js         parses, matches, dedups, notifies, pushes; owns the automatic cycle,
                      the queue / rate-limit wait, and the block stop
challenge-content.js  notices verification challenges and blocks (observes only, never answers)
highlight-content.js  outlines the target date after a notification click
quickcheck-content.js signs in, clicks through to the calendar, selects post + applicant,
                      holds through the queue / rate-limit page, auto-books when enabled
lib/jitter.js         interval spread, inter-action spread, failure backoff
lib/parse.js          finds dates in a response without relying on fixed field names
lib/match.js          date-range filtering, and the seen-set diff
lib/triage.js         ok / expired / challenge / rate-limited / blocked classification
lib/storage.js        typed wrappers over chrome.storage
```

`quickcheck-content.js` acts only when the worker has set a one-shot request flag
immediately beforehand. No flag, no interaction — which is why an ordinary visit to the
portal never touches anything. The flag survives the sign-in redirects, carried forward
explicitly at each hop and cleared on arrival at the calendar.

Calendar responses are read only within a window after the worker starts a check (the wait
limit plus 15 minutes). A response outside one is you browsing, and is dropped before it
is parsed.

The portal's API is a single RPC dispatcher — `POST /en-US/custom-actions/` with a
`route` parameter selecting the server action and `parameters` carrying arguments. That
was learned from observed traffic, not documentation. (Public write-ups describe this
portal as Salesforce Aura at `/s/sfsites/aura`; this instance is not, which is why
nothing here hardcodes an endpoint shape.)

`parse.js` is deliberately schema-agnostic — it matches date-shaped values and nearby
availability/location hints rather than known field names — and separates three zero-date
outcomes: **no openings** (normal), **dates present but unmatched** (schema drift; the
popup prints the real structure), and **unreadable response**.

## Activity log (操作记录)

The popup's **操作记录** link opens a page listing everything the extension did, newest
first and updating live: checks started and their results (with the open dates), sign-in
steps, queue / rate-limit waits and reruns, challenges, blocks, desktop notifications,
phone pushes (and push failures), bookings, setting changes, and every progress banner a
check showed on the portal page (marked 网页). It keeps the latest 1,000 entries, can be
filtered to results and problems or searched, and can be copied or exported as a `.txt`.

## Diagnostics

The **技术详情** section at the bottom of the activity-log page records **endpoint paths,
query parameter names, and body key names only — never values**. Telemetry endpoints are
excluded outright, because they carry your email address and session ids.

If the extension isn't picking up your calendar, that section plus the **LAST RESPONSE**
block is what identifies why.

## Tests

```bash
npm test
```

138 tests over parsing, matching, response triage (including rate-limit vs. block), maintenance-page detection, post
selection, page identification, challenge precedence, sign-in and security-question
detection, question wording in English and Chinese, question-to-answer-box pairing, answer
matching, schedule-link finding, request flag lifetime, and timing, run against fixtures.
No live requests to the portal.

The post-selection, sign-in and security-question tests lift the finders out of
`quickcheck-content.js` and run the real functions, rather than copies that could drift
from what ships.

Several tests exist because of specific false positives that made it into earlier
versions — a terms page quoting "Prohibited Conduct" being read as a ban, and a
Salesforce label bundle containing the string `"Access Limitation"` doing the same. Both
hard-stopped the extension over nothing. Those fixtures are worth keeping.

## Limits

- Availability parsing is heuristic until validated against a real response; if a check
  finds nothing while the calendar clearly shows openings, the popup's response structure
  output is what to correct it against.
- Automatic checking needs Chrome running and the computer awake. A screen that has turned
  off is fine; a machine that has gone to sleep runs nothing until it wakes.
- A challenge that clears within 5 minutes is not pushed; one that does not is reported
  by the watchdog as a failed check.
- Auto sign-in covers usvisascheduling.com and the atlasauth.b2clogin.com tenant it
  federates to. Any other domain is out of reach.
- Security-question detection is heuristic — it keys on question-shaped text near a lone
  input, because the answer box carries nothing to identify it. It is tuned to fail closed:
  an unrecognised page stops the check and reports what it saw rather than typing into it.
- A one-time code sent to your email or phone is not something this can answer. If the
  portal escalates to that, automatic sign-in stops and tells you.
- Reaching the calendar depends on finding the app's Schedule link. If the portal renames
  or restructures that navigation, the check stops and says so rather than falling back to
  the deep link that doesn't work.
- The portal's terms prohibit automated access, and this extension automates it.
