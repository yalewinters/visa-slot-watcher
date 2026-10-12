/**
 * Classifies a poll response before anything tries to parse it.
 *
 * Order matters: a block reads a lot like an ordinary error page, and a challenge
 * interstitial reads a lot like a login redirect. Most specific test wins.
 */

/**
 * A small, targeted description of a response for diagnosis: what kind of thing came
 * back and what phrase triggered a verdict. Deliberately not a body dump — these
 * responses can carry personal appointment data.
 */
export function describeResponse(status, text, finalUrl = '') {
  const body = typeof text === 'string' ? text : '';
  const isHtml = looksLikeHtml(body);
  const info = {
    status,
    bytes: body.length,
    kind: isHtml ? 'html' : (body.trim().startsWith('{') || body.trim().startsWith('[') ||
      /^\s*while\s*\(1\)\s*;/.test(body) ? 'json' : 'other'),
    finalUrl: finalUrl ? finalUrl.split('?')[0] : '',
    announced: isHtml ? announcedText(body).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  };

  const scope = isHtml ? announcedText(body) : body;
  const hit = BLOCKED_RE.exec(scope) || RATE_RE.exec(scope) || BLOCKED_SOFT_RE.exec(scope) ||
    CHALLENGE_RE.exec(scope);
  if (hit) {
    const at = Math.max(0, hit.index - 60);
    info.evidence = scope.slice(at, hit.index + hit[0].length + 60).replace(/\s+/g, ' ').trim();
  }
  return info;
}

export const OK = 'ok';
export const EXPIRED = 'expired';
export const CHALLENGE = 'challenge';
export const BLOCKED = 'blocked';
export const ERROR = 'error';
// A virtual-queue / waiting-room interstitial. Not a refusal and not a bot-check — the
// site is holding you in line under load and forwards you on by itself — so it carries no
// backoff. Detected in the page, not in a poll response, so triage() never returns it.
export const QUEUED = 'queued';
// The portal (or Cloudflare in front of it) is rate-limiting: HTTP 429, or a "you are being
// rate limited" page. Temporary by nature — waited out up to the configured limit, then the
// check is run again. Kept apart from BLOCKED, which stops automatic checking outright.
export const RATE_LIMITED = 'ratelimited';

// "prohibited conduct" is deliberately NOT a trigger on its own: it is the title of a
// section in the portal's own terms, so any page or payload quoting the terms would
// otherwise be read as a block — and a false block hard-stops the watcher.
const BLOCKED_RE = /access\s*limitation|you\s*have\s*been\s*blocked|your\s*access\s*(has\s*been\s*)?(is\s*)?(been\s*)?(restricted|revoked|suspended)/i;
// Weaker phrases only count alongside a refusal status code.
const BLOCKED_SOFT_RE = /prohibited\s*conduct|access\s*denied|violation/i;
const RATE_RE = /rate[\s-]*limit(ed|ing)?|too\s*many\s*requests|error\s*1015/i;
const CHALLENGE_RE = /captcha|recaptcha|hcaptcha|are\s*you\s*(a\s*)?human|verif\w*\s*(you|your)\s*(are|is|identity)|not\s*a\s*bot|checking\s*your\s*browser|just\s*a\s*moment|performing\s*security\s*verification|security\s*service\s*to\s*protect|protect\s*against\s*malicious\s*bots|enable\s*javascript\s*and\s*cookies|_incapsula_resource|incapsula|imperva|distil|px-captcha|cf-challenge|challenge-platform/i;
const EXPIRED_RE = /aura:invalidSession|invalidSession|COOKIE_NOT_FOUND|session\s*(has\s*)?(expired|timed\s*out)|please\s*log\s*in|sign\s*in\s*to\s*continue/i;
const LOGIN_PAGE_RE = /<input[^>]+type=["']password["']|name=["']?(username|j_username)["']?/i;

/** Does this body look like an HTML document rather than an API response? */
export function looksLikeHtml(body) {
  const head = body.slice(0, 2000).trim().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') ||
    (head.includes('<head') && head.includes('<meta'));
}

/**
 * Text an HTML page uses to announce itself. A Salesforce page ships large bundles of
 * localized label strings, so a block phrase can appear in ordinary markup as a label
 * that is never displayed — scanning the whole document would read that as a live block.
 */
export function announcedText(body) {
  const title = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(body);
  const headings = [...body.matchAll(/<h[12][^>]*>([\s\S]{0,300}?)<\/h[12]>/gi)]
    .slice(0, 10).map((m) => m[1]);
  return [title ? title[1] : '', ...headings].join(' ').replace(/<[^>]+>/g, ' ');
}

/**
 * @param {number} status  HTTP status
 * @param {string} text    response body (may be HTML or API JSON)
 * @param {string} finalUrl  URL after redirects
 * @returns {{kind: string, reason: string}}
 */
export function triage(status, text, finalUrl = '') {
  const body = typeof text === 'string' ? text.slice(0, 400000) : '';
  const isHtml = looksLikeHtml(body);

  // In HTML, only trust a block phrase where the page announces it. In an API payload,
  // anywhere in the body is fair game — there is no incidental prose there.
  const blockScope = isHtml ? announcedText(body) : body;

  if (BLOCKED_RE.test(blockScope)) {
    return { kind: BLOCKED, reason: '预约网站返回了访问受限提示' };
  }

  // Before the 403 checks: Cloudflare's rate-limit page (error 1015) is titled "Access
  // denied", which would otherwise read as a block and stop automatic checking for good.
  if (status === 429 || RATE_RE.test(blockScope)) {
    return { kind: RATE_LIMITED, reason: '被预约网站限流' };
  }

  if (status === 403 && BLOCKED_SOFT_RE.test(body)) {
    return { kind: BLOCKED, reason: 'HTTP 403，并提到违规行为' };
  }
  if (status === 403) {
    return {
      kind: BLOCKED,
      reason: '预约网站返回 HTTP 403（也可能只是请求有问题，不一定是封禁）'
    };
  }
  if (CHALLENGE_RE.test(body)) {
    return { kind: CHALLENGE, reason: '响应中出现人机验证' };
  }
  if (status === 401 || EXPIRED_RE.test(body)) {
    return { kind: EXPIRED, reason: '登录会话已失效' };
  }
  if (/\/login|\/secur\/login|SignIn/i.test(finalUrl) || LOGIN_PAGE_RE.test(body)) {
    return { kind: EXPIRED, reason: '被重定向到登录页' };
  }

  // Checked only after the specific verdicts above, since challenge and login pages are
  // HTML too. Reaching here with HTML means the replay never hit the API at all — a
  // misdirected request, not a ban.
  if (isHtml && status < 400) {
    return {
      kind: ERROR,
      reason: '收到的是网页而不是接口数据——请求没有到达接口'
    };
  }
  if (status >= 400) {
    return { kind: ERROR, reason: `HTTP ${status}` };
  }
  if (!body.trim()) {
    return { kind: ERROR, reason: '响应为空' };
  }
  return { kind: OK, reason: '' };
}
