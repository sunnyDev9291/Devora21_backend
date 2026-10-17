(() => {
  const BOOT = "2.1.9";
  const DEBOUNCE_MS = 450;
  const DETECT_INTERVAL_MS = 1200;
  const POLL_MS = 1500;
  const CHOICE_SETTLE_MS = 100;
  const timers = new Map();
  let latchedApplyPage = false;
  const isTopFrame = window === window.top;
  const lastValues = new Map();
  const questionCache = new Map();

  if (globalThis.__devora21QaBoot === BOOT) return;
  globalThis.__devora21QaBoot = BOOT;
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

  function isChoiceEl(el) {
    if (!el) return false;
    const type = String(el.type || "").toLowerCase();
    if (type === "radio" || type === "checkbox") return true;
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    if (role === "radio" || role === "checkbox" || role === "switch") return true;
    if (el.getAttribute?.("data-option")) return true;
    if (el.closest?.(".ashby-application-form-input-yesno, [class*='yesno']")) {
      return true;
    }
    return false;
  }

  function pushDomEvent(el, eventType) {
    const api = Dom();
    if (!api?.isTrackableControl?.(el)) return;

    const cached = (() => {
      try {
        return questionCache.get(api.elementKey(el)) || null;
      } catch {
        return null;
      }
    })();

    let draft;
    try {
      draft = api.buildDomInputEvent(el, eventType, {
        includeContext: !cached,
        cachedQuestion: cached?.question,
        cachedConfidence: cached?.confidence,
      });
    } catch {
      return;
    }
    if (!draft?.elementKey) return;
    if (lastValues.get(draft.elementKey) === draft.value) return;

    // Skip empty poll noise before first match.
    if (
      eventType === "poll" &&
      !cached &&
      !String(draft.value || "").trim()
    ) {
      return;
    }

    if (timers.has(draft.elementKey)) {
      clearTimeout(timers.get(draft.elementKey));
    }

    timers.set(
      draft.elementKey,
      setTimeout(async () => {
        timers.delete(draft.elementKey);
        try {
          await notifyApplyPageIfNeeded();
          if (!(await shouldBuffer())) return;

          const stillCached = questionCache.get(draft.elementKey);
          const fresh = api.buildDomInputEvent(el, eventType, {
            includeContext: !stillCached,
            includeInspection: true,
            cachedQuestion: stillCached?.question,
            cachedConfidence: stillCached?.confidence,
          });
          if (!fresh?.elementKey) return;
          if (lastValues.get(fresh.elementKey) === fresh.value) return;

          const res = await chrome.runtime.sendMessage({
            type: "DOM_INPUT_EVENT",
            ...fresh,
            pageTitle: document.title || "",
            tabUrl: location.href,
          });
          if (res?.ok) {
            lastValues.set(fresh.elementKey, fresh.value);
            if (res.cachedQuestion) {
              questionCache.set(fresh.elementKey, {
                question: res.cachedQuestion,
                confidence: res.cachedConfidence ?? 0.9,
              });
            }
          }
        } catch {
          // extension context invalidated
        }
      }, DEBOUNCE_MS)
    );
  }

  function onEvent(e) {
    const api = Dom();
    if (!api?.resolveControl) return;
    const el = api.resolveControl(e.target);
    if (!el) return;
    const eventType = e.type || "input";

    // For text fields, ignore pure click/focus — wait for value change.
    const type = String(el.type || "").toLowerCase();
    const tag = el.tagName;
    const isTextLike =
      tag === "TEXTAREA" ||
      el.isContentEditable ||
      (tag === "INPUT" &&
        !["checkbox", "radio", "file", "range", "button", "submit"].includes(
          type
        ));
    if (
      isTextLike &&
      (eventType === "click" ||
        eventType === "pointerup" ||
        eventType === "focusin")
    ) {
      return;
    }

    if (
      (eventType === "click" || eventType === "pointerup") &&
      isChoiceEl(el)
    ) {
      setTimeout(() => pushDomEvent(el, eventType), CHOICE_SETTLE_MS);
      return;
    }
    pushDomEvent(el, eventType);
  }

  document.addEventListener("input", onEvent, true);
  document.addEventListener("change", onEvent, true);
  document.addEventListener("keyup", onEvent, true);
  document.addEventListener("click", onEvent, true);
  document.addEventListener("pointerup", onEvent, true);

  setInterval(() => {
    void (async () => {
      if (!(await shouldBuffer())) return;
      const api = Dom();
      if (!api) return;
      const focused = document.activeElement;
      if (focused && api.isTrackableControl?.(focused)) {
        pushDomEvent(focused, "poll");
      }
      for (const el of api.listActiveChoiceControls?.(document) || []) {
        pushDomEvent(el, "poll");
      }
    })();
  }, POLL_MS);

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
    const existing = document.getElementById("devora21-qa-banner");
    if (existing && existing !== banner) existing.remove();
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
      const n = res.bufferCount || 0;
      banner.textContent =
        n > 0
          ? `Devora21 · syncing ${n} event(s)`
          : "Devora21 · Apply page · waiting for input";
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

  /** Single-element page outline (synced to scroll / resize / DOM mutations). */
  const HL_BOX_ID = "devora21-qa-outline";
  let trackedEl = null;
  let trackedSelector = "";
  let outlineBox = null;
  let rafPending = false;
  let outlineMo = null;

  function ensureOutlineBox() {
    if (outlineBox && document.contains(outlineBox)) return outlineBox;
    outlineBox = document.createElement("div");
    outlineBox.id = HL_BOX_ID;
    outlineBox.setAttribute("aria-hidden", "true");
    outlineBox.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483645",
      "box-sizing:border-box",
      "border:2px solid #7c3aed",
      "background:rgba(124,58,237,0.08)",
      "border-radius:2px",
      "display:none",
      "margin:0",
      "padding:0",
    ].join(";");
    (document.documentElement || document.body).appendChild(outlineBox);
    return outlineBox;
  }

  function readRect(el) {
    try {
      const r = el.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        bottom: r.bottom,
        right: r.right,
        x: r.x,
        y: r.y,
      };
    } catch {
      return null;
    }
  }

  function applyOutlineRect() {
    rafPending = false;
    if (!isTopFrame) return;
    const box = ensureOutlineBox();
    if (!trackedEl || !document.contains(trackedEl)) {
      // Try re-resolve by selector after DOM mutations.
      if (trackedSelector) {
        try {
          trackedEl = document.querySelector(trackedSelector);
        } catch {
          trackedEl = null;
        }
      }
    }
    if (!trackedEl || !document.contains(trackedEl)) {
      box.style.display = "none";
      return;
    }
    const r = readRect(trackedEl);
    if (!r || (r.width <= 0 && r.height <= 0)) {
      box.style.display = "none";
      return;
    }
    box.style.display = "block";
    box.style.top = `${r.top}px`;
    box.style.left = `${r.left}px`;
    box.style.width = `${Math.max(1, r.width)}px`;
    box.style.height = `${Math.max(1, r.height)}px`;
  }

  function scheduleOutlineUpdate() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(applyOutlineRect);
  }

  function clearPageHighlights() {
    trackedEl = null;
    trackedSelector = "";
    if (outlineBox) {
      outlineBox.style.display = "none";
    }
  }

  function highlightSelectorOnPage(selector, opts = {}) {
    if (!isTopFrame || !selector) return { ok: false, reason: "no_selector" };
    let el = null;
    try {
      el = document.querySelector(selector);
    } catch {
      return { ok: false, reason: "bad_selector" };
    }
    if (!el) return { ok: false, reason: "not_found" };

    trackedSelector = selector;
    trackedEl = el;
    ensureOutlineBox();
    if (opts.scroll !== false) {
      try {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      } catch {
        // ignore
      }
    }
    applyOutlineRect();
    const rect = readRect(el);
    return {
      ok: true,
      rect,
      tagName: (el.tagName || "").toLowerCase(),
      id: el.id || "",
      className: typeof el.className === "string" ? el.className : "",
      outerHTML: String(el.outerHTML || "").slice(0, 12_000),
    };
  }

  function bindOutlineListeners() {
    if (!isTopFrame) return;
    window.addEventListener("scroll", scheduleOutlineUpdate, true);
    window.addEventListener("resize", scheduleOutlineUpdate, true);
    try {
      outlineMo = new MutationObserver(() => scheduleOutlineUpdate());
      outlineMo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: false,
      });
    } catch {
      // ignore
    }
  }
  bindOutlineListeners();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "MATCH_CACHE_UPDATE" && message.entries) {
      for (const e of message.entries) {
        if (e?.elementKey && e?.question && e.matchStatus === "matched") {
          questionCache.set(e.elementKey, {
            question: e.question,
            confidence: e.confidence ?? 0.9,
          });
        }
      }
      return false;
    }
    if (message?.type === "HIGHLIGHT_DOM_NODE") {
      const res = highlightSelectorOnPage(message.cssSelector, {
        scroll: message.scroll !== false,
      });
      sendResponse(res);
      return false;
    }
    if (message?.type === "GET_ELEMENT_INFO") {
      let el = null;
      try {
        el = message.cssSelector
          ? document.querySelector(message.cssSelector)
          : null;
      } catch {
        el = null;
      }
      if (!el) {
        sendResponse({ ok: false, reason: "not_found" });
        return false;
      }
      sendResponse({
        ok: true,
        rect: readRect(el),
        tagName: (el.tagName || "").toLowerCase(),
        id: el.id || "",
        className: typeof el.className === "string" ? el.className : "",
        textContent: String(el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000),
        outerHTML: String(el.outerHTML || "").slice(0, 12_000),
        exists: true,
      });
      return false;
    }
    if (message?.type === "CLEAR_HIGHLIGHTS") {
      clearPageHighlights();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "FORCE_APPLY_SCAN") {
      void (async () => {
        const signals = await notifyApplyPageIfNeeded();
        sendResponse({
          ok: true,
          frameUrl: location.href,
          boot: BOOT,
          hasDomApi: Boolean(Dom()),
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
