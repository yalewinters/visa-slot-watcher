/**
 * Isolated-world relay. Plants the nonce the MAIN-world hook uses, then forwards
 * validated captures to the service worker.
 */
(() => {
  'use strict';

  const MAGIC = '__VSW_CAPTURE__';
  const OBSERVED = '__VSW_OBSERVED__';
  const nonce = (crypto.randomUUID && crypto.randomUUID()) ||
    String(Math.random()).slice(2) + Date.now();

  function plant() {
    if (!document.documentElement) return false;
    document.documentElement.dataset.vswNonce = nonce;
    return true;
  }

  if (!plant()) {
    new MutationObserver((_, obs) => {
      if (plant()) obs.disconnect();
    }).observe(document, { childList: true, subtree: true });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;

    const data = event.data;
    if (!data || data.nonce !== nonce) return;

    let outgoing = null;
    if (data.__vsw === MAGIC && data.payload && typeof data.payload.url === 'string') {
      outgoing = { type: 'AVAILABILITY', payload: data.payload };
    } else if (data.__vsw === OBSERVED && data.entry) {
      outgoing = { type: 'OBSERVED', entry: data.entry };
    }
    if (!outgoing) return;

    try {
      chrome.runtime.sendMessage(outgoing, () => {
        // Swallow "receiving end does not exist" — the worker may be spinning up.
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context invalidated (reload/update). Nothing useful to do.
    }
  });
})();
