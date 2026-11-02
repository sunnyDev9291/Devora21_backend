/**
 * Devora21 rrweb recorder (all frames) — size-optimized but replay-safe.
 *
 * Critical: FullSnapshot must never be dropped (white screen in replay).
 * Stylesheets must be inlined so cross-origin CSS works in rrweb-player.
 */
(function () {
  const IS_TOP = window === window.top;
  const IDLE_MS = 3 * 60 * 1000;

  let stopFn = null;
  let recording = false;
  let paused = false;
  /** When true, emit() accepts events (incl. sync FullSnapshot during record()). */
  let acceptingEvents = false;
  let clientSessionId = null;
  let frameKey = null;
  let idleTimer = null;
  let activityBound = false;

  function buildFrameKey() {
    try {
      if (IS_TOP) return "top";
      const u = new URL(location.href);
      return `iframe:${u.origin}${u.pathname}`;
    } catch {
      return IS_TOP ? "top" : `iframe:${location.href.slice(0, 200)}`;
    }
  }

  function getRecordFn() {
    if (typeof rrwebRecord === "function") return rrwebRecord;
    if (rrwebRecord && typeof rrwebRecord.record === "function") {
      return rrwebRecord.record.bind(rrwebRecord);
    }
    if (
      typeof window.rrweb !== "undefined" &&
      typeof window.rrweb.record === "function"
    ) {
      return window.rrweb.record;
    }
    return null;
  }

  function emitToBackground(event) {
    try {
      chrome.runtime.sendMessage({
        type: "RRWEB_EVENT",
        clientSessionId,
        frameKey,
        href: location.href,
        isTop: IS_TOP,
        event,
      });
    } catch {
      // extension context invalidated
    }
  }

  function recordOptions() {
    return {
      emit(event) {
        // Must accept the synchronous FullSnapshot fired inside record().
        if (!acceptingEvents || !clientSessionId) return;
        emitToBackground(event);
      },
      maskInputOptions: { password: true },
      /**
       * REQUIRED for usable replay. With false, rrweb-player cannot load
       * cross-origin CSS → blank white page + cursor only.
       */
      inlineStylesheet: true,
      /** Still skip embedding images (size). */
      inlineImages: false,
      recordCanvas: false,
      collectFonts: false,
      slimDOMOptions: {
        script: true,
        comment: true,
        headFavicon: true,
        headWhitespace: true,
        headMetaDescKeywords: true,
        headMetaSocial: true,
        headMetaRobots: true,
        headMetaHttpEquiv: true,
        headMetaAuthorship: true,
        headMetaVerification: true,
      },
      sampling: {
        mousemove: true,
        mouseInteraction: true,
        scroll: 150,
        input: "last",
      },
      // Do not block img — empty media holes are OK; blank DOM is not.
      blockSelector: "video,audio",
    };
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (!recording || !clientSessionId || paused) return;
    idleTimer = setTimeout(() => {
      pauseRecording("idle");
    }, IDLE_MS);
  }

  function onUserActivity() {
    if (!clientSessionId) return;
    if (document.visibilityState === "hidden") return;
    if (paused) {
      resumeRecording();
    } else {
      armIdleTimer();
    }
  }

  function bindActivityListeners() {
    if (activityBound) return;
    activityBound = true;
    const opts = { capture: true, passive: true };
    for (const type of [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "pointerdown",
      "input",
      "change",
    ]) {
      document.addEventListener(type, onUserActivity, opts);
    }
    document.addEventListener(
      "visibilitychange",
      () => {
        if (!clientSessionId) return;
        if (document.visibilityState === "hidden") {
          pauseRecording("hidden");
        } else {
          resumeRecording();
        }
      },
      true
    );
  }

  function startRecordEngine() {
    const record = getRecordFn();
    if (!record) return { ok: false, error: "rrweb record bundle missing" };
    try {
      // Accept events BEFORE record() so the initial FullSnapshot is kept.
      acceptingEvents = true;
      paused = false;
      stopFn = record(recordOptions());
      recording = true;
      return { ok: true };
    } catch (err) {
      acceptingEvents = false;
      recording = false;
      stopFn = null;
      return { ok: false, error: String(err?.message || err) };
    }
  }

  function stopRecordEngine() {
    acceptingEvents = false;
    if (typeof stopFn === "function") {
      try {
        stopFn();
      } catch {
        // ignore
      }
    }
    stopFn = null;
    recording = false;
  }

  function pauseRecording(_reason) {
    if (!clientSessionId || paused) return;
    clearIdleTimer();
    stopRecordEngine();
    paused = true;
  }

  function resumeRecording() {
    if (!clientSessionId) return;
    if (document.visibilityState === "hidden") return;
    if (recording && !paused) {
      armIdleTimer();
      return;
    }
    // startRecordEngine clears paused and keeps FullSnapshot
    const res = startRecordEngine();
    if (res.ok) {
      armIdleTimer();
    }
  }

  function startRecording(sessionId) {
    if (clientSessionId === sessionId && recording && !paused) {
      return { ok: true, already: true };
    }
    stopRecordEngine();
    clearIdleTimer();
    clientSessionId = sessionId;
    frameKey = buildFrameKey();
    bindActivityListeners();

    if (document.visibilityState === "hidden") {
      paused = true;
      recording = false;
      acceptingEvents = false;
      return { ok: true, frameKey, isTop: IS_TOP, paused: true };
    }

    const res = startRecordEngine();
    if (!res.ok) return res;
    armIdleTimer();
    return { ok: true, frameKey, isTop: IS_TOP };
  }

  function stopRecording() {
    clearIdleTimer();
    stopRecordEngine();
    paused = false;
    clientSessionId = null;
    return { ok: true };
  }

  /** Ask background to upload buffered events before the tab dies. */
  function requestFlushNow() {
    if (!clientSessionId) return;
    try {
      chrome.runtime.sendMessage({
        type: "RRWEB_FLUSH_NOW",
        clientSessionId,
      });
    } catch {
      // ignore
    }
  }

  // Tab close / navigate away — push pending events while SW can still upload.
  window.addEventListener("pagehide", () => {
    requestFlushNow();
  });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        requestFlushNow();
      }
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "RRWEB_START") {
      sendResponse(startRecording(msg.clientSessionId));
      return true;
    }
    if (msg.type === "RRWEB_STOP") {
      sendResponse(stopRecording());
      return true;
    }
    if (msg.type === "RRWEB_STATUS") {
      sendResponse({
        ok: true,
        recording: recording && !paused,
        paused,
        clientSessionId,
        frameKey,
        isTop: IS_TOP,
      });
      return true;
    }
  });

  try {
    chrome.runtime.sendMessage(
      { type: "RRWEB_CONTENT_READY", isTop: IS_TOP },
      (res) => {
        if (chrome.runtime.lastError) return;
        if (res?.shouldRecord && res?.clientSessionId) {
          startRecording(res.clientSessionId);
        }
      }
    );
  } catch {
    // ignore
  }
})();
