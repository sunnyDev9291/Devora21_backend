(() => {
  const DEBOUNCE_MS = 350;
  const DETECT_INTERVAL_MS = 1200;
  const timers = new Map();
  let latchedApplyPage = false;
  const isTopFrame = window === window.top;
  /** Last synced value per elementKey — skip unchanged. */
  const lastValues = new Map();

  if (globalThis.__devora21QaContentLoaded) return;
  globalThis.__devora21QaContentLoaded = true;

  function detect() {
    const api = globalThis.Devora21DetectApply;
    if (!api) {
      return { hasEmail: false, hasResumeUpload: false, isApplyPage: false };
    }
    return api.detectApplyPageSignals(document);
  }

  const Dom = () => globalThis.Devora21DomEvent;

  async function getRecordingState() {
    try {
      return await chrome.runtime.sendMessage({
        type: "GET_RECORDING_STATE",
        url: location.href,
      });
    } catch {
      return null;
    }
  }

  async function shouldBuffer() {
    const res = await getRecordingState();
    return Boolean(res?.canBuffer);
  }

  async function notifyApplyPageIfNeeded() {
    const signals = detect();
    if (signals.isApplyPage) latchedApplyPage = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "APPLY_PAGE_DETECTED",
        url: location.href,
        pageTitle: document.title || "",
        hasEmail: Boolean(signals.hasEmail),
        hasResumeUpload: Boolean(signals.hasResumeUpload),
      });
      if (res?.isApplyPage) latchedApplyPage = true;
    } catch {
      // extension context invalidated
    }
    return signals;
  }

  function queueDomEvent(el, eventType) {
    const api = Dom();
    if (!api?.isTrackableControl?.(el)) return;

    const draft = api.buildDomInputEvent(el, eventType);
    if (!draft?.elementKey) return;

    // Skip if value unchanged since last capture for this element.
    const prev = lastValues.get(draft.elementKey);
    if (prev !== undefined && prev === draft.value) return;

    if (timers.has(draft.elementKey)) {
      clearTimeout(timers.get(draft.elementKey));
    }

    timers.set(
      draft.elementKey,
      setTimeout(async () => {
        timers.delete(draft.elementKey);
        await notifyApplyPageIfNeeded();
        if (!(await shouldBuffer())) return;

        const fresh = api.buildDomInputEvent(el, eventType);
        if (!fresh?.elementKey) return;
        if (lastValues.get(fresh.elementKey) === fresh.value) return;

        lastValues.set(fresh.elementKey, fresh.value);
        try {
          await chrome.runtime.sendMessage({
            type: "DOM_INPUT_EVENT",
            ...fresh,
            pageTitle: document.title || "",
            tabUrl: location.href,
          });
        } catch {
          // extension context invalidated
        }
      }, DEBOUNCE_MS)
    );
  }

  function onEvent(e) {
    const api = Dom();
    if (!api) return;
    const el = api.resolveControl(e.target);
    if (!el) return;
    queueDomEvent(el, e.type || "input");
  }

  document.addEventListener("input", onEvent, true);
  document.addEventListener("change", onEvent, true);
  document.addEventListener("click", onEvent, true);
  document.addEventListener("blur", onEvent, true);

  const banner = document.createElement("div");
  banner.id = "devora21-qa-banner";
  banner.style.cssText = [
    "position:fixed",
    "bottom:12px",
    "right:12px",
    "z-index:2147483646",
    "padding:6px 10px",
    "border-radius:6px",
    "font:12px/1.3 system-ui,sans-serif",
    "background:#0284c7",
    "color:#fff",
    "box-shadow:0 4px 14px rgba(0,0,0,.2)",
    "display:none",
    "pointer-events:none",
  ].join(";");
  banner.textContent = "Devora21 · buffering";

  function mountBanner() {
    if (!isTopFrame || !document.body) return;
    if (!document.getElementById("devora21-qa-banner")) {
      document.body.appendChild(banner);
    }
  }

  async function refreshBanner() {
    if (!isTopFrame) {
      await notifyApplyPageIfNeeded();
      return;
    }
    mountBanner();
    await notifyApplyPageIfNeeded();
    const res = await getRecordingState();
    if (!res?.canBuffer && !res?.enabled) {
      banner.style.display = "none";
      return;
    }
    banner.style.display = "block";
    if (res?.enabled && res?.isApplyPage) {
      banner.style.background = "#0f766e";
      banner.textContent = "Devora21 · Apply page · syncing events";
    } else if (res?.canBuffer) {
      banner.style.background = "#0284c7";
      const n = res.bufferCount || 0;
      banner.textContent =
        n > 0
          ? `Devora21 · buffering ${n} event(s)…`
          : "Devora21 · waiting for Apply Page (buffering on)";
    } else {
      banner.style.display = "none";
    }
  }

  const mo = new MutationObserver(() => {
    void notifyApplyPageIfNeeded();
  });

  function startObserver() {
    if (!document.documentElement) return;
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "type",
        "name",
        "id",
        "accept",
        "autocomplete",
        "aria-label",
        "placeholder",
        "src",
      ],
    });
  }

  function watchIframes() {
    const bind = (frame) => {
      if (!frame || frame.__devora21IframeBound) return;
      frame.__devora21IframeBound = true;
      frame.addEventListener("load", () => {
        void notifyApplyPageIfNeeded();
        try {
          chrome.runtime.sendMessage({
            type: "REQUEST_FRAME_SCAN",
            url: location.href,
          });
        } catch {
          // ignore
        }
      });
    };
    document.querySelectorAll("iframe, frame").forEach(bind);
    const iframeMo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes || []) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches?.("iframe, frame")) bind(node);
          node.querySelectorAll?.("iframe, frame").forEach(bind);
        }
      }
    });
    if (document.documentElement) {
      iframeMo.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }

  void (async () => {
    const res = await getRecordingState();
    if (res?.isApplyPage) latchedApplyPage = true;
  })();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "FORCE_APPLY_SCAN") {
      void (async () => {
        const signals = await notifyApplyPageIfNeeded();
        sendResponse({
          ok: true,
          frameUrl: location.href,
          ...signals,
        });
      })();
      return true;
    }
    return false;
  });

  mountBanner();
  startObserver();
  watchIframes();
  void refreshBanner();
  setInterval(refreshBanner, DETECT_INTERVAL_MS);
})();
