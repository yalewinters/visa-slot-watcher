/**
 * MAIN-world hook. Runs at document_start, before the portal's own scripts.
 *
 * It wraps fetch() and XMLHttpRequest purely to *observe* traffic. Every call is passed
 * through untouched; nothing is blocked, delayed, rewritten or replayed. When a response
 * carries appointment availability, it is handed to the service worker to be matched
 * against the user's date range.
 *
 * Passive by design: the extension issues no requests of its own, so it never needs to
 * reconstruct one. Only responses the page already fetched are read.
 *
 * It also keeps a redacted log of every request the page makes, so an endpoint we don't
 * recognise can be identified instead of guessed at.
 */
(() => {
  'use strict';

  const MAGIC = '__VSW_CAPTURE__';
  const OBSERVED = '__VSW_OBSERVED__';

  // These portals are served by several different runtimes; which one a given post uses
  // isn't something we can assume. `/custom-actions/` is the one usvisascheduling.com
  // actually uses — a single RPC dispatcher where a `route` parameter selects the
  // server action — confirmed from observed traffic, not from documentation.
  const API_PATHS = [
    '/custom-actions',     // usvisascheduling.com RPC dispatcher
    '/s/sfsites/aura',     // Aura / Experience Cloud
    '/sfsites/aura',
    '/aura',
    '/webruntime/api',     // LWR (Lightning Web Runtime)
    '/services/apexrest',
    '/services/data'
  ];

  // Telemetry endpoints are noisy and carry personal data; never treat them as API calls.
  const IGNORE_PATHS = [
    '/v2/track', '/OneCollector', '/cdn-cgi/', '/collect', '/b/ss', 'monitor.azure.com'
  ];

  const DATE_RE = /\d{4}-\d{2}-\d{2}/;
  const AVAILABILITY_HINT = /(availab|slot|appointment|timeslot|calendar|opening|schedul)/i;
  const MAX_SAMPLE = 200000;

  // Confidence levels, high to low. A fully-booked calendar returns no dates at all, so
  // the response alone can't be the test — otherwise the request could only ever be
  // learned while slots existed, which is precisely when it isn't needed. The request
  // itself looks identical either way, so it carries the weaker but always-available
  // signal, and a better capture later upgrades it.
  const CONFIDENCE = { RESPONSE: 3, REQUEST: 2, AURA: 1 };

  let nonce = null;

  /**
   * The isolated-world script plants a nonce on <html> at document_start. Grab it and
   * strip it so page scripts can't read it and forge captures. Injection order between
   * worlds is not guaranteed, so this is re-tried lazily on every send rather than being
   * a one-shot handshake — getting this wrong silently disables capture entirely.
   */
  function grabNonce() {
    if (nonce) return true;
    const el = document.documentElement;
    if (!el || !el.dataset || !el.dataset.vswNonce) return false;
    nonce = el.dataset.vswNonce;
    delete el.dataset.vswNonce;
    return true;
  }

  if (!grabNonce()) {
    const watch = () => {
      if (!document.documentElement) return false;
      if (grabNonce()) return true;              // may have landed before we got here
      const obs = new MutationObserver(() => {
        if (grabNonce()) obs.disconnect();
      });
      obs.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-vsw-nonce']
      });
      return true;
    };
    if (!watch()) document.addEventListener('readystatechange', watch, { once: true });
  }

  const isIgnored = (url) => IGNORE_PATHS.some((p) => url.includes(p));
  const isApiCall = (url) => !isIgnored(url) && API_PATHS.some((p) => url.includes(p));

  /**
   * How sure we are that this call is the availability lookup.
   * @returns {number} a CONFIDENCE level, or 0 to ignore the call
   */
  function scoreCall(requestBody, responseText) {
    const body = typeof responseText === 'string' ? responseText : '';
    const request = typeof requestBody === 'string' ? requestBody : '';
    let decoded = request;
    try { decoded = decodeURIComponent(request); } catch { /* keep raw */ }

    // Dates in the response: unmistakable, but only present when slots exist.
    if (DATE_RE.test(body) && AVAILABILITY_HINT.test(body)) return CONFIDENCE.RESPONSE;

    // The method/class name in the request. Identical whether the calendar comes back
    // full or empty, which is what makes an empty calendar capturable at all.
    if (AVAILABILITY_HINT.test(decoded)) return CONFIDENCE.REQUEST;

    if (/"state"\s*:\s*"SUCCESS"/.test(body) && /(month|year|date)/i.test(decoded)) {
      return CONFIDENCE.AURA;
    }
    return 0;
  }

  function absolute(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  }

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach((v, k) => { out[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) out[k] = v;
      } else if (typeof h === 'object') {
        for (const k of Object.keys(h)) out[k] = String(h[k]);
      }
    } catch { /* headers are best-effort */ }
    return out;
  }

  function normalizeBody(body) {
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.toString();
    }
    return null; // FormData / Blob / stream bodies aren't replayable as-is
  }

  /* ------------------------------------------------------------ diagnostics */

  /**
   * A redacted description of one request: enough to identify the endpoint and action,
   * with no values. Salesforce puts the action name in the *query parameter name*
   * (e.g. `other.Foo.getAvailability=1`) and the Apex class/method in the message body,
   * so names alone identify the call while values — including tokens — stay out.
   */
  function describeCall(url, method, body, status, responseText) {
    let parsed;
    try { parsed = new URL(url, location.href); } catch { return null; }

    const entry = {
      method,
      path: parsed.pathname,
      params: [...parsed.searchParams.keys()].slice(0, 25),
      status,
      bytes: (responseText || '').length,
      hasDates: DATE_RE.test(responseText || ''),
      at: Date.now()
    };

    if (typeof body === 'string' && body) {
      const trimmed = body.trim();
      const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
      // URLSearchParams accepts ANY string without throwing, so a JSON or opaque body
      // would parse as one enormous "key" and get logged verbatim. These bodies carry
      // emails, session ids and telemetry, so the guard has to come first.
      const isForm = !isJson && trimmed.includes('=') && !/\s/.test(trimmed.slice(0, 200));

      if (isForm) {
        try {
          const form = new URLSearchParams(body);
          entry.bodyKeys = [...form.keys()].slice(0, 15).map((k) => k.slice(0, 60));
          const message = form.get('message');
          if (message) {
            const json = JSON.parse(message);
            if (Array.isArray(json.actions)) {
              entry.actions = json.actions.slice(0, 6).map((a) => {
                const p = a.params || {};
                return [a.descriptor || a.callingDescriptor, p.classname, p.method]
                  .filter(Boolean).join(' / ').slice(0, 120);
              });
            }
          }
        } catch {
          entry.bodyKeys = ['<form body>'];
        }
      } else if (isJson) {
        // Top-level key names only. Never values.
        try {
          const json = JSON.parse(trimmed);
          const source = Array.isArray(json) ? (json[0] || {}) : json;
          entry.bodyKeys = Object.keys(source).slice(0, 15).map((k) => k.slice(0, 60));
        } catch {
          entry.bodyKeys = ['<json body>'];
        }
      } else {
        entry.bodyKeys = ['<opaque body>'];
      }
    }
    return entry;
  }

  let observedCount = 0;
  function observe(url, method, body, status, responseText) {
    if (observedCount > 400) return; // stop logging on very long-lived pages
    if (isIgnored(url)) return;      // telemetry carries emails and session ids
    observedCount++;
    const entry = describeCall(url, method, body, status, responseText);
    if (!entry) return;
    if (!grabNonce()) return;
    window.postMessage({ __vsw: OBSERVED, nonce, entry }, location.origin);
  }

  /* ---------------------------------------------------------------- capture */

  let lastSignature = null;

  function send(payload) {
    if (!grabNonce()) return;
    // The calendar re-fetches constantly as it renders. Only forward when the response
    // actually differs, so the worker is not re-parsing the same payload repeatedly.
    const signature = payload.url + '|' + payload.status + '|' + payload.sample.length +
      '|' + payload.sample.slice(0, 200);
    if (signature === lastSignature) return;
    lastSignature = signature;

    window.postMessage({ __vsw: MAGIC, nonce, payload }, location.origin);
  }

  function consider(meta, responseText) {
    observe(meta.url, meta.method, meta.body, meta.status, responseText);
    if (!isApiCall(meta.url)) return;

    const confidence = scoreCall(meta.body, responseText);
    if (!confidence) return;

    // Passive mode: only the *response* is forwarded. The request is never recorded,
    // because nothing replays it — the extension issues no requests of its own.
    send({
      confidence,
      url: absolute(meta.url),
      status: meta.status,
      seenAt: Date.now(),
      pageUrl: location.href,
      sample: (responseText || '').slice(0, MAX_SAMPLE)
    });
  }

  /* ------------------------------------------------------------------ fetch */

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (...args) {
      const promise = nativeFetch.apply(this, args);
      promise.then(
        (res) => { try { inspectFetch(args, res); } catch { /* never break the page */ } },
        () => {}
      );
      return promise;
    };
  }

  async function inspectFetch(args, res) {
    const [input, init] = args;
    const url = typeof input === 'string'
      ? input
      : (input && typeof input.url === 'string' ? input.url : String(input));

    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = String((init && init.method) || (isRequest ? input.method : 'GET')).toUpperCase();

    let headers = headersToObject(init && init.headers);
    if (isRequest && Object.keys(headers).length === 0) headers = headersToObject(input.headers);

    let body = init ? init.body : null;
    if (body == null && isRequest) {
      try { body = await input.clone().text(); } catch { body = null; }
    }
    body = normalizeBody(body);

    let text = '';
    try { text = await res.clone().text(); } catch { /* opaque or already consumed */ }

    consider(
      { source: 'fetch', url, method, headers, body, status: res.status },
      text
    );
  }

  /* -------------------------------------------------------------------- XHR */

  const XHR = XMLHttpRequest.prototype;
  const nativeOpen = XHR.open;
  const nativeSend = XHR.send;
  const nativeSetHeader = XHR.setRequestHeader;

  XHR.open = function (method, url, ...rest) {
    try {
      this.__vsw = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} };
    } catch { /* ignore */ }
    return nativeOpen.call(this, method, url, ...rest);
  };

  XHR.setRequestHeader = function (name, value) {
    try {
      if (this.__vsw) this.__vsw.headers[name] = value;
    } catch { /* ignore */ }
    return nativeSetHeader.call(this, name, value);
  };

  XHR.send = function (body) {
    try {
      const meta = this.__vsw;
      if (meta) {
        meta.body = normalizeBody(body);
        meta.source = 'xhr';
        this.addEventListener('load', () => {
          try {
            const type = this.responseType;
            const text = (type === '' || type === 'text') ? this.responseText : '';
            meta.status = this.status;
            consider(meta, text);
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
    return nativeSend.call(this, body);
  };
})();
