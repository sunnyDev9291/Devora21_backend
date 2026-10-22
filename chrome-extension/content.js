/**
 * Submit-triggered capture (one-shot):
 * click Submit → intercept → capture/upload → brief unhook →
 * native click → re-arm (so validation failure can Submit again).
 */
(() => {
  const BOOT = "3.2.5";
  if (globalThis.__devora21CaptureBoot === BOOT) return;
  globalThis.__devora21CaptureBoot = BOOT;

  const isTopFrame = window === window.top;
  let hooksActive = true;
  let captureArmed = false;
  let capturing = false;
  /** True only while we briefly unhook to let the site's real submit run. */
  let pausingForNative = false;
  let pendingTarget = null;
  let scanTimer = null;
  let mo = null;

  const Detect = () => globalThis.Devora21DetectApply;

  /** Keep SUBMIT_BUTTON_TEXTS in sync with options / chrome.storage.sync. */
  function applySubmitButtonTextsFromStorage(list) {
    const api = Detect();
    if (!api?.setSubmitButtonTexts) return;
    api.setSubmitButtonTexts(list);
  }

  function showBanner(text, tone = "info") {
    if (!isTopFrame || !document.body) return;
    let el = document.getElementById("devora21-capture-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "devora21-capture-banner";
      el.style.cssText = [
        "position:fixed",
        "bottom:16px",
        "right:16px",
        "z-index:2147483646",
        "max-width:320px",
        "padding:10px 14px",
        "border-radius:10px",
        "font:13px/1.35 system-ui,sans-serif",
        "box-shadow:0 8px 28px rgba(0,0,0,.22)",
        "color:#fff",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(el);
    }
    const bg =
      tone === "error"
        ? "#b91c1c"
        : tone === "ok"
          ? "#0f766e"
          : tone === "warn"
            ? "#d97706"
            : "#0369a1";
    el.style.background = bg;
    el.textContent = text;
    el.style.display = "block";
  }

  function hideBannerSoon(ms = 2500) {
    setTimeout(() => {
      const el = document.getElementById("devora21-capture-banner");
      if (el) el.style.display = "none";
    }, ms);
  }

  async function refreshArmed() {
    if (pausingForNative || capturing) return captureArmed;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "GET_RECORDING_STATE",
        url: location.href,
      });
      captureArmed = Boolean(res?.canCapture);
    } catch {
      captureArmed = false;
    }
    return captureArmed;
  }

  function scan() {
    const api = Detect();
    if (!api) return { isApplyPage: false, submitCount: 0 };
    // During capture / native pause, keep last known status (don't flicker to No).
    if (capturing || pausingForNative) {
      return { isApplyPage: true, submitCount: 1 };
    }
    // Disarmed: detect for UI only — do not mark.
    if (!hooksActive || !captureArmed) {
      return api.detectApplyPageSignals(document, { mark: false });
    }
    return api.detectApplyPageSignals(document, { mark: true });
  }

  let lastNotifyKey = "";
  /** Sticky in this frame: once we saw Submit, keep reporting Yes for status. */
  let frameSawSubmit = false;

  async function notifyDetected() {
    await refreshArmed();
    const signals = scan();
    if (signals.isApplyPage) frameSawSubmit = true;
    const reportFound = Boolean(signals.isApplyPage || frameSawSubmit);
    const reportCount = Math.max(1, signals.submitCount || 0, frameSawSubmit ? 1 : 0);
    const key = `${reportFound}:${reportCount}`;
    // Skip duplicate reports from this frame (MutationObserver spam).
    if (key === lastNotifyKey) return signals;
    lastNotifyKey = key;
    try {
      await chrome.runtime.sendMessage({
        type: "APPLY_PAGE_DETECTED",
        url: location.href,
        pageTitle: document.title || "",
        isApplyPage: reportFound,
        submitCount: reportCount,
      });
    } catch {
      // ignore
    }
    return { ...signals, isApplyPage: reportFound, submitCount: reportCount };
  }

  function isWindowRoot(root) {
    return (
      root === document.documentElement ||
      root === document.body ||
      root === document.scrollingElement
    );
  }

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Form / submit / dialog that identifies the apply UI for this capture. */
  function findApplyAnchor() {
    const selectors = [
      "[data-devora21-capture-submit]",
      '[data-ui="application-form-submit"]',
      'button[data-ui="application-form-submit"]',
      'form[data-ui="application-form"]',
      '[data-role="dialog-content"]',
      '[data-role="dialog-container"]',
      '[role="dialog"]',
      '[aria-modal="true"]',
    ];
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch {
        // ignore
      }
    }
    return null;
  }

  function isModalLike(el) {
    if (!el || !(el instanceof Element)) return false;
    try {
      if (el.getAttribute?.("role") === "dialog") return true;
      if (el.getAttribute?.("aria-modal") === "true") return true;
      const role = el.getAttribute?.("data-role") || "";
      if (/dialog|modal|drawer|sheet/i.test(role)) return true;
      if (el.hasAttribute?.("data-scroll-top-offset")) return true;
      if (el.hasAttribute?.("data-scroll-bottom-offset")) return true;
      const cls = typeof el.className === "string" ? el.className : "";
      if (/(^|[^a-z])(modal|dialog|drawer|overlay|sheet)([^a-z]|$)/i.test(cls)) {
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  function canOverflowY(style) {
    const oy = `${style.overflowY || ""} ${style.overflow || ""}`;
    return /(auto|scroll|overlay)/.test(oy);
  }

  /** overflow:hidden can still scroll via scrollTop on some ATS modals. */
  function canHiddenScroll(style) {
    const oy = `${style.overflowY || ""} ${style.overflow || ""}`;
    return /hidden/.test(oy);
  }

  function readScrollY(root) {
    if (!root) return 0;
    if (isWindowRoot(root)) {
      return (
        window.scrollY ||
        window.pageYOffset ||
        document.documentElement.scrollTop ||
        document.body?.scrollTop ||
        0
      );
    }
    return root.scrollTop || 0;
  }

  function rootRelatedToApply(root) {
    const anchor = findApplyAnchor();
    if (!anchor) return false;
    if (isWindowRoot(root)) return true;
    if (root.contains?.(anchor)) return true;
    // Sticky footer submit sits outside the scroll pane but shares the dialog.
    const dialog = anchor.closest?.(
      '[role="dialog"], [data-role="dialog-container"], [aria-modal="true"]'
    );
    return Boolean(dialog && dialog.contains(root));
  }

  function metricsForRoot(root) {
    const win = isWindowRoot(root);
    const viewportH = win
      ? window.innerHeight
      : Math.max(1, root.clientHeight || window.innerHeight);
    const scrollHeight = win
      ? Math.max(
          document.documentElement.scrollHeight || 0,
          document.body?.scrollHeight || 0,
          root.scrollHeight || 0
        )
      : root.scrollHeight || 0;
    const scrollY = readScrollY(root);
    const maxScroll = Math.max(0, scrollHeight - viewportH);
    return {
      viewportH,
      windowInnerHeight: window.innerHeight,
      scrollHeight,
      scrollY,
      maxScroll,
      devicePixelRatio: Number(window.devicePixelRatio) || 1,
      isTopFrame: window === window.top,
      rootIsWindow: win,
      scrollLevel: win
        ? window === window.top
          ? "browser"
          : "iframe"
        : "dom",
      hasApplyForm: rootRelatedToApply(root),
      modalLike: !win && isModalLike(root),
    };
  }

  /** Nudge stubborn DOM scrollers that ignore scrollTop alone. */
  function dispatchScrollNudge(root, deltaY) {
    if (!root || isWindowRoot(root)) return;
    try {
      root.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY,
          deltaMode: 0,
        })
      );
    } catch {
      // ignore
    }
    try {
      root.dispatchEvent(
        new Event("scroll", { bubbles: true, cancelable: false })
      );
    } catch {
      // ignore
    }
  }

  /** Force scroll with multiple strategies — sites ignore a single approach. */
  function applyScroll(root, y) {
    const top = Math.max(0, Math.floor(y));
    if (!root) return;
    if (isWindowRoot(root)) {
      try {
        window.scrollTo(0, top);
      } catch {
        // ignore
      }
      try {
        window.scrollTo({ top, left: 0, behavior: "instant" });
      } catch {
        try {
          window.scrollTo({ top, left: 0, behavior: "auto" });
        } catch {
          // ignore
        }
      }
      document.documentElement.scrollTop = top;
      if (document.body) document.body.scrollTop = top;
      const se = document.scrollingElement;
      if (se && se !== document.documentElement && se !== document.body) {
        se.scrollTop = top;
      }
      return;
    }
    const before = root.scrollTop || 0;
    root.scrollTop = top;
    try {
      root.scrollTo?.(0, top);
    } catch {
      // ignore
    }
    try {
      root.scrollTo?.({ top, left: 0, behavior: "auto" });
    } catch {
      // ignore
    }
    // If scrollTop was ignored, wheel-nudge toward the target.
    const after = root.scrollTop || 0;
    if (Math.abs(after - top) > 8 && Math.abs(after - before) < 2) {
      dispatchScrollNudge(root, top - before);
      root.scrollTop = top;
    }
  }

  /**
   * Collect every plausible scroller across browser / iframe / DOM levels.
   * Workable & similar ATS lock the page and scroll a modal content panel.
   */
  function collectScrollCandidates() {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };

    // Level 1 — browser / document (or iframe document when all_frames).
    add(document.scrollingElement || document.documentElement);
    add(document.documentElement);
    add(document.body);

    // Level 3 — known modal / dialog scroll shells (Workable, Greenhouse, etc.).
    const explicitSelectors = [
      '[data-role="dialog-content-container"]',
      '[data-role="dialog-content"]',
      '[data-role="dialog-container"]',
      "[data-scroll-top-offset]",
      "[data-scroll-bottom-offset]",
      '[role="dialog"]',
      '[aria-modal="true"]',
      "[data-ui='application-form']",
      "form[data-ui='application-form']",
      ".applicationModal__modal-content",
      "[class*='modal-content']",
      "[class*='ModalContent']",
      "[class*='dialog-content']",
      "[class*='DialogContent']",
      "[class*='drawer-content']",
    ];
    for (const sel of explicitSelectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => add(el));
      } catch {
        // ignore
      }
    }

    // Walk ancestors of the apply form / submit — the real scroller is usually
    // one of these (Workable: dialog-content-container).
    const anchor = findApplyAnchor();
    if (anchor) {
      let node = anchor;
      for (let i = 0; i < 24 && node; i++) {
        if (node instanceof HTMLElement) add(node);
        node = node.parentElement;
      }
    }

    // Broad DOM scan for overflow scrollers.
    try {
      const nodes = document.querySelectorAll("body *");
      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.clientHeight < 48) continue;
        const excess = el.scrollHeight - el.clientHeight;
        if (excess < 24) continue;
        let style;
        try {
          style = getComputedStyle(el);
        } catch {
          continue;
        }
        const tallEnough =
          excess > 60 &&
          el.clientHeight >= Math.min(160, window.innerHeight * 0.2);
        if (canOverflowY(style) || (canHiddenScroll(style) && tallEnough) || tallEnough) {
          add(el);
        }
      }
    } catch {
      // ignore
    }
    return out;
  }

  function scoreCandidate(root, moved) {
    const m = metricsForRoot(root);
    if (m.maxScroll < 16) return -1;

    let score = m.maxScroll;
    // Prefer roots that actually moved when probed.
    if (moved) score += 1_000_000;

    const containsApply = rootRelatedToApply(root);

    // Critical for Workable: prefer the modal DOM scroller over the page behind it.
    if (containsApply && !m.rootIsWindow) score += 5_000_000;
    if (m.modalLike && moved) score += 2_000_000;
    if (m.modalLike) score += 500_000;

    // Prefer larger visible area among equals.
    score += Math.min(m.viewportH, window.innerHeight);

    // Window is a fallback only — never beat a working DOM modal scroller.
    if (m.rootIsWindow) {
      score += containsApply ? 10 : 0;
      // Soft demote so a short modal still wins over a long background page.
      if (moved && containsApply) score -= 50_000;
    }
    return score;
  }

  /**
   * Probe which root actually scrolls across browser / iframe / DOM levels.
   */
  async function probeBestScrollRoot() {
    const candidates = collectScrollCandidates();
    let best = null;
    let bestScore = -1;

    for (const root of candidates) {
      const before = metricsForRoot(root);
      if (before.maxScroll < 16) continue;

      const testY = Math.min(
        before.maxScroll,
        Math.max(64, Math.floor(before.viewportH * 0.35))
      );
      const y0 = before.scrollY;
      applyScroll(root, testY);
      await sleepMs(70);
      let midY = readScrollY(root);
      let moved = Math.abs(midY - y0) >= 12;

      // DOM-only second try: wheel nudge then re-set scrollTop.
      if (!moved && !isWindowRoot(root)) {
        dispatchScrollNudge(root, testY - y0 || 120);
        applyScroll(root, testY);
        await sleepMs(70);
        midY = readScrollY(root);
        moved = Math.abs(midY - y0) >= 12;
      }

      applyScroll(root, 0);
      await sleepMs(30);

      const score = scoreCandidate(root, moved);
      if (score > bestScore) {
        best = root;
        bestScore = score;
      }
    }

    if (best) return best;

    // Prefer an apply-modal ancestor even if probe couldn't move it yet.
    const anchor = findApplyAnchor();
    if (anchor) {
      let node = anchor.parentElement;
      while (node) {
        if (node instanceof HTMLElement) {
          const excess = (node.scrollHeight || 0) - (node.clientHeight || 0);
          if (excess >= 16) return node;
        }
        node = node.parentElement;
      }
    }

    return (
      document.scrollingElement ||
      document.documentElement ||
      document.body
    );
  }

  function findScrollRoot() {
    // Sync fallback used before async probe completes.
    const candidates = collectScrollCandidates();
    let best = document.scrollingElement || document.documentElement;
    let bestScore = -1;
    for (const root of candidates) {
      const score = scoreCandidate(root, false);
      if (score > bestScore) {
        best = root;
        bestScore = score;
      }
    }
    return best;
  }

  let savedScroll = null;
  let scrollRootRef = null;
  /** Locked for one capture run — re-finding mid-run broke 10% overlap. */
  let pinnedScrollRoot = null;

  function getScrollRoot() {
    if (pinnedScrollRoot && document.contains(pinnedScrollRoot)) {
      return pinnedScrollRoot;
    }
    return findScrollRoot();
  }

  async function pinScrollRoot() {
    pinnedScrollRoot = await probeBestScrollRoot();
    scrollRootRef = pinnedScrollRoot;
    applyScroll(pinnedScrollRoot, 0);
    await sleepMs(40);
    return pinnedScrollRoot;
  }

  function unpinScrollRoot() {
    pinnedScrollRoot = null;
  }

  function scrollMetrics() {
    const root = getScrollRoot();
    scrollRootRef = root;
    return {
      ...metricsForRoot(root),
      pinned: Boolean(pinnedScrollRoot),
    };
  }

  function scrollToY(y) {
    const root = getScrollRoot();
    scrollRootRef = root;
    const m = metricsForRoot(root);
    const top = Math.max(0, Math.min(Math.floor(y), m.maxScroll));
    applyScroll(root, top);
  }

  /** Scroll pinned root, then wait until scroll position stops changing. */
  async function scrollToYAndWaitSettle(y) {
    const root = getScrollRoot();
    const m0 = metricsForRoot(root);
    const target = Math.max(0, Math.min(Math.floor(y), m0.maxScroll));
    applyScroll(root, target);

    // If it didn't move toward target, retry DOM strategies (never steal
    // browser scroll when a modal/DOM root is pinned — Workable case).
    await sleepMs(50);
    let yNow = readScrollY(root);
    if (Math.abs(yNow - target) > 20 && m0.maxScroll > 20) {
      applyScroll(root, target);
      if (!isWindowRoot(root)) {
        dispatchScrollNudge(root, target - yNow);
        applyScroll(root, target);
      }
    }

    let last = -1;
    let stable = 0;
    for (let i = 0; i < 55; i++) {
      await sleepMs(40);
      yNow = readScrollY(root);
      if (Math.abs(yNow - last) < 1) {
        stable += 1;
        if (stable >= 2) {
          return { ok: true, ...metricsForRoot(root), targetY: target };
        }
      } else {
        stable = 0;
      }
      last = yNow;
      if (yNow >= m0.maxScroll - 1 && target >= m0.maxScroll - 1 && stable >= 1) {
        return { ok: true, ...metricsForRoot(root), targetY: target };
      }
    }
    return { ok: true, ...metricsForRoot(root), targetY: target };
  }

  function saveScroll() {
    if (!pinnedScrollRoot) {
      scrollRootRef = findScrollRoot();
    }
    const m = scrollMetrics();
    if (savedScroll == null) savedScroll = m.scrollY;
    return m;
  }

  function restoreScroll() {
    if (savedScroll == null) {
      unpinScrollRoot();
      return;
    }
    scrollToY(savedScroll);
    savedScroll = null;
    scrollRootRef = null;
    unpinScrollRoot();
  }

  function stopDomWatchers() {
    try {
      mo?.disconnect?.();
    } catch {
      // ignore
    }
    mo = null;
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = null;
    }
  }

  function removeInterceptHooks() {
    hooksActive = false;
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("submit", onSubmit, true);
  }

  function installInterceptHooks() {
    if (hooksActive) return;
    hooksActive = true;
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
  }

  function clearAllMarks() {
    const api = Detect();
    try {
      document
        .querySelectorAll?.(
          `[${api?.MARK_ATTR || "data-devora21-capture-submit"}="1"]`
        )
        ?.forEach((el) => {
          if (api?.clearMark) api.clearMark(el);
          else el.removeAttribute("data-devora21-capture-submit");
        });
    } catch {
      // ignore
    }
  }

  function restoreButton(el) {
    const api = Detect();
    if (el && api?.clearMark) {
      api.clearMark(el);
      return;
    }
    if (el && api?.restoreOriginalLabel) {
      api.restoreOriginalLabel(el);
      return;
    }
    el?.removeAttribute?.("data-devora21-capture-submit");
  }

  /** Brief pause in this frame so the site's real submit is not intercepted. */
  function pauseHooksInThisFrame() {
    pausingForNative = true;
    capturing = false;
    removeInterceptHooks();
    stopDomWatchers();
    clearAllMarks();
  }

  /** Re-arm after native submit so the next Submit click captures again. */
  async function resumeHooksInThisFrame() {
    pausingForNative = false;
    capturing = false;
    pendingTarget = null;
    installInterceptHooks();
    startObserver();
    startScanTimer();
    await refreshArmed();
    // Re-mark Submit for the next click.
    lastNotifyKey = "";
    void notifyDetected();
  }

  /**
   * After capture/upload: briefly unhook → fire real submit → re-arm.
   * Site validation can fail; user can click Submit again and capture runs again.
   */
  async function pauseHooksNativeSubmitThenRearm(button) {
    const el = button && document.contains(button) ? button : pendingTarget;

    pauseHooksInThisFrame();
    restoreButton(el);
    restoreScroll();

    // Pause every frame so iframes don't intercept the native click.
    try {
      await chrome.runtime.sendMessage({ type: "PAUSE_CAPTURE_HOOKS" });
    } catch {
      // ignore
    }

    showBanner("Submitting…", "ok");
    hideBannerSoon(2000);

    await new Promise((r) => setTimeout(r, 40));
    try {
      if (el && document.contains(el) && typeof el.click === "function") {
        el.click();
      } else {
        const form = el?.form || el?.closest?.("form");
        if (form?.requestSubmit) form.requestSubmit();
        else if (form?.submit) form.submit();
      }
    } catch (err) {
      showBanner(String(err?.message || err), "error");
      hideBannerSoon(4000);
    }

    // Let site validation / navigation settle, then re-arm for another Submit.
    await new Promise((r) => setTimeout(r, 500));
    try {
      await chrome.runtime.sendMessage({ type: "RESUME_CAPTURE_HOOKS" });
    } catch {
      // ignore
    }
    await resumeHooksInThisFrame();
    showBanner("Ready — click Submit again to re-capture", "info");
    hideBannerSoon(2500);
  }

  function unlockWithoutSubmit() {
    capturing = false;
    pausingForNative = false;
    pendingTarget = null;
    restoreScroll();
    installInterceptHooks();
    startObserver();
    startScanTimer();
  }

  async function startCapturePipeline(target) {
    if (capturing || pausingForNative) return;
    capturing = true;
    pendingTarget = target;
    stopDomWatchers(); // avoid MutationObserver storms during capture/submit
    showBanner("Capturing application page…", "info");

    try {
      const res = await chrome.runtime.sendMessage({
        type: "START_SUBMIT_CAPTURE",
        url: location.href,
        pageTitle: document.title || "",
      });

      if (res?.ok) {
        await pauseHooksNativeSubmitThenRearm(target);
        return;
      }

      const err = res?.error || "Capture failed";
      showBanner(err, "error");
      const retry = window.confirm(
        `${err}\n\nRetry capture?\n\nOK = Retry · Cancel = unlock form`
      );
      if (retry) {
        capturing = false;
        startObserver();
        startScanTimer();
        await startCapturePipeline(target);
        return;
      }
      const submitAnyway = window.confirm(
        "Submit without saving screenshots?"
      );
      if (submitAnyway) {
        await pauseHooksNativeSubmitThenRearm(target);
      } else {
        unlockWithoutSubmit();
        showBanner("Form unlocked — capture cancelled.", "warn");
        hideBannerSoon(3000);
      }
    } catch (e) {
      unlockWithoutSubmit();
      showBanner(String(e?.message || e), "error");
      hideBannerSoon(4000);
    }
  }

  /**
   * Same list as Detection Status — resolve at click time (not mark-only).
   * Survives React re-renders that strip data-devora21-capture-submit.
   */
  function resolveCaptureSubmitButton(fromEvent) {
    const api = Detect();
    if (!api) return null;
    if (typeof api.resolveSubmitControlFromEvent === "function") {
      return api.resolveSubmitControlFromEvent(fromEvent);
    }
    // Fallback if an older detect-apply is still injected.
    const path =
      typeof fromEvent.composedPath === "function" ? fromEvent.composedPath() : [];
    for (const n of path) {
      if (n instanceof HTMLElement && api.isRawSubmitCandidate?.(n)) return n;
    }
    const t =
      fromEvent.target instanceof HTMLElement ? fromEvent.target : null;
    const closest = t?.closest?.(
      "button, input[type='submit'], input[type='button'], [role='button'], a[role='button']"
    );
    if (closest && api.isRawSubmitCandidate?.(closest)) return closest;
    return null;
  }

  function onClick(e) {
    if (!hooksActive || pausingForNative) return;
    if (!captureArmed) return;
    if (capturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const api = Detect();
    const target = resolveCaptureSubmitButton(e);
    if (!target) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    api?.applyCaptureLabel?.(target);
    void startCapturePipeline(target);
  }

  function onSubmit(e) {
    if (!hooksActive || pausingForNative) return;
    if (!captureArmed) return;
    if (capturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const api = Detect();
    const form = e.target;
    if (!(form instanceof HTMLFormElement) || !api) return;

    let submitter = null;
    if (e.submitter instanceof HTMLElement && api.isRawSubmitCandidate?.(e.submitter)) {
      submitter = e.submitter;
    } else {
      submitter =
        api.resolveSubmitControlFromEvent?.(e) ||
        api.pickPrimarySubmit?.(form) ||
        api.findSubmitControls?.(form)?.[0] ||
        null;
    }

    if (!submitter || !api.isRawSubmitCandidate?.(submitter)) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    api.applyCaptureLabel?.(submitter);
    void startCapturePipeline(submitter);
  }

  function startObserver() {
    if (mo || pausingForNative) return;
    if (!document.documentElement) return;
    mo = new MutationObserver(() => {
      if (capturing || pausingForNative) return;
      scan();
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  function startScanTimer() {
    if (scanTimer) return;
    scanTimer = setInterval(() => {
      if (capturing || pausingForNative) return;
      void notifyDetected();
    }, 2500);
  }

  document.addEventListener("click", onClick, true);
  document.addEventListener("submit", onSubmit, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CAPTURE_PIN_SCROLL_ROOT") {
      void pinScrollRoot().then(() => {
        const m = saveScroll();
        sendResponse({ ok: true, ...m });
      });
      return true;
    }
    if (message?.type === "CAPTURE_UNPIN_SCROLL_ROOT") {
      unpinScrollRoot();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "CAPTURE_SCROLL_METRICS") {
      if (message.pin) {
        void pinScrollRoot().then(() => {
          sendResponse({ ok: true, ...saveScroll() });
        });
        return true;
      }
      sendResponse({ ok: true, ...saveScroll() });
      return true;
    }
    if (message?.type === "CAPTURE_REPROBE_SCROLL_ROOT") {
      // Mid-capture: pinned root didn't move — probe again and re-pin.
      unpinScrollRoot();
      void pinScrollRoot().then(() => {
        sendResponse({ ok: true, ...saveScroll() });
      });
      return true;
    }
    if (message?.type === "CAPTURE_SCROLL_TO") {
      const y = Number(message.y) || 0;
      if (message.waitSettle) {
        void scrollToYAndWaitSettle(y).then((m) =>
          sendResponse({ ok: true, ...m })
        );
        return true;
      }
      scrollToY(y);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "CAPTURE_RESTORE_SCROLL") {
      restoreScroll();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "FORCE_APPLY_SCAN") {
      void notifyDetected().then((s) => sendResponse({ ok: true, ...s }));
      return true;
    }
    if (message?.type === "CAPTURE_STATUS") {
      showBanner(message.text || "", message.tone || "info");
      if (message.hideMs) hideBannerSoon(message.hideMs);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "CAPTURE_CONFIRM_DONE") {
      // Legacy path — prefer inline flow after START_SUBMIT_CAPTURE.
      if (message.ok && pendingTarget && capturing) {
        void pauseHooksNativeSubmitThenRearm(pendingTarget);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "PAUSE_CAPTURE_HOOKS") {
      pauseHooksInThisFrame();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "RESUME_CAPTURE_HOOKS") {
      void resumeHooksInThisFrame().then(() => sendResponse({ ok: true }));
      return true;
    }
    // Legacy alias from older builds
    if (message?.type === "TEARDOWN_CAPTURE_HOOKS") {
      pauseHooksInThisFrame();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  function loadSubmitButtonTexts() {
    try {
      chrome.storage.sync.get({ submitButtonTexts: ["Submit"] }, (data) => {
        applySubmitButtonTextsFromStorage(data?.submitButtonTexts);
        lastNotifyKey = "";
        void notifyDetected();
      });
    } catch {
      // ignore
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes.submitButtonTexts) return;
      applySubmitButtonTextsFromStorage(changes.submitButtonTexts.newValue);
      lastNotifyKey = "";
      void notifyDetected();
    });
  } catch {
    // ignore
  }

  loadSubmitButtonTexts();
  void notifyDetected();
  startObserver();
  startScanTimer();

  if (isTopFrame) {
    showBanner("Devora21 · ready", "info");
    hideBannerSoon(1500);
  }
})();
