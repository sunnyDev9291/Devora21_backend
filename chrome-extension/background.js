import {
  getSettings,
  getTabState,
  setTabState,
  newTabSessionId,
  hostAllowed,
} from "./lib/storage.js";
import {
  uploadApplicationCapture,
  fetchMe,
  listCaptures,
} from "./lib/api.js";
import {
  beginCaptureSession,
  appendCaptureSlice,
  setCaptureSessionStatus,
  getCaptureSession,
  listCaptureSessions,
  isUrlBusy,
  normalizeCaptureUrl,
  deleteCaptureSession,
  clearCaptureBuffer,
} from "./lib/capture-buffer.js";

/** 10% overlap → advance by 90% of viewport each step. */
const OVERLAP_RATIO = 0.1;
const SCROLL_STEP_RATIO = 1 - OVERLAP_RATIO; // 0.9
const MAX_SLICES = 30;
const MAX_HEIGHT_PX = 14000;
const JPEG_QUALITY = 0.55;
const TARGET_WIDTH = 1280;
/** Extra wait AFTER scroll has fully stopped, before each screenshot. */
const POST_SCROLL_DELAY_MS = 500;
/** Chrome ~2 captureVisibleTab / sec — small gap between captures. */
const CAPTURE_GAP_MS = 550;

/** tabId currently running a capture (overlap guard) */
const capturingTabs = new Set();

async function enableSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("[devora21] sidePanel:", err?.message || err);
  }
}
void enableSidePanelBehavior();
chrome.runtime.onInstalled.addListener(() => {
  void enableSidePanelBehavior();
});

function emptyTabState(tabUrl = "") {
  return {
    tabSessionId: newTabSessionId(),
    paused: false,
    tabUrl: tabUrl || "",
    pageTitle: "",
    isApplyPage: false,
    submitCount: 0,
    applyHost: null,
    lastCaptureId: null,
    lastCaptureStatus: null,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Only reset apply-page sticky state when the TAB's top-level host changes.
 * Never use iframe/message URLs here — those were wiping Yes → No on Ashby.
 */
async function reconcileHost(tabId, _hintUrl) {
  const state = await getTabState(tabId);
  let topUrl = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    topUrl = tab.url || "";
  } catch {
    topUrl = "";
  }
  const topHost = hostOf(topUrl);
  const prevHost = state.applyHost || hostOf(state.tabUrl || "");
  if (prevHost && topHost && prevHost !== topHost) {
    await setTabState(tabId, emptyTabState(topUrl));
    return getTabState(tabId);
  }
  // Keep tabUrl aligned to the real tab address when known.
  if (topUrl && state.tabUrl !== topUrl) {
    state.tabUrl = topUrl;
  }
  return state;
}

async function updateBadge(tabId) {
  const settings = await getSettings();
  const state = await getTabState(tabId);
  let text = "";
  let color = "#64748b";
  if (!settings.consentAccepted || !settings.captureEnabled) {
    text = "OFF";
    color = "#64748b";
  } else if (state.paused) {
    text = "||";
    color = "#d97706";
  } else if (state.isApplyPage) {
    text = "CAP";
    color = "#0f766e";
  } else {
    text = "…";
    color = "#94a3b8";
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // tab gone
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendToTab(tabId, message, frameId) {
  if (typeof frameId === "number") {
    return chrome.tabs.sendMessage(tabId, message, { frameId });
  }
  return chrome.tabs.sendMessage(tabId, message);
}

/** Deliver to every frame — capture may have started where the button lives. */
async function broadcastToTab(tabId, message) {
  let frames = null;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch {
    frames = null;
  }
  if (frames?.length) {
    await Promise.all(
      frames.map((f) =>
        chrome.tabs
          .sendMessage(tabId, message, { frameId: f.frameId })
          .catch(() => {})
      )
    );
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // ignore
  }
}

async function listTabFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames?.length) return frames;
  } catch {
    // ignore
  }
  return [{ frameId: 0 }];
}

/**
 * Ask every frame to probe which element actually scrolls; pick the winner.
 * (ATS pages often lock html/body and scroll an inner panel / iframe.)
 */
async function pickBestScrollTarget(tabId) {
  const frames = await listTabFrames(tabId);
  const results = await Promise.all(
    frames.map(async (f) => {
      try {
        // Pin runs the async probe (tests which root actually moves).
        const m = await chrome.tabs.sendMessage(
          tabId,
          { type: "CAPTURE_PIN_SCROLL_ROOT" },
          { frameId: f.frameId }
        );
        if (!m?.ok) return null;
        return {
          frameId: f.frameId,
          viewportH: Number(m.viewportH) || 0,
          scrollHeight: Number(m.scrollHeight) || 0,
          maxScroll: Number(m.maxScroll) || 0,
          devicePixelRatio: Number(m.devicePixelRatio) || 1,
          isTopFrame: Boolean(m.isTopFrame),
          rootIsWindow: Boolean(m.rootIsWindow),
          scrollLevel: String(m.scrollLevel || ""),
          hasApplyForm: Boolean(m.hasApplyForm),
          modalLike: Boolean(m.modalLike),
        };
      } catch {
        return null;
      }
    })
  );
  const ok = results.filter(Boolean);
  if (!ok.length) return null;
  // Prefer: apply-form frame → DOM/modal scroller → largest maxScroll → top frame.
  ok.sort((a, b) => {
    if (a.hasApplyForm !== b.hasApplyForm) {
      return Number(b.hasApplyForm) - Number(a.hasApplyForm);
    }
    const aDom = !a.rootIsWindow && a.maxScroll >= 16;
    const bDom = !b.rootIsWindow && b.maxScroll >= 16;
    if (aDom !== bDom) return Number(bDom) - Number(aDom);
    if (a.modalLike !== b.modalLike) {
      return Number(b.modalLike) - Number(a.modalLike);
    }
    if (b.maxScroll !== a.maxScroll) return b.maxScroll - a.maxScroll;
    if (b.scrollHeight !== a.scrollHeight) return b.scrollHeight - a.scrollHeight;
    return Number(b.isTopFrame) - Number(a.isTopFrame);
  });
  return ok[0];
}

async function captureVisibleJpeg(windowId) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 70,
      });
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || "");
      if (/MAX_CAPTURE_VISIBLE_TAB|quota|rate/i.test(msg)) {
        await sleep(CAPTURE_GAP_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Screenshot capture failed");
}

/**
 * Convert data URL JPEG â†’ grayscale, resize, recompress via OffscreenCanvas.
 * cropTopPx / cropBottomPx are in capture (device) pixels to drop overlapping bands.
 */
async function processSlice(
  dataUrl,
  { targetWidth = TARGET_WIDTH, cropTopPx = 0, cropBottomPx = 0 } = {}
) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const top = Math.max(0, Math.min(bitmap.height - 1, Math.round(cropTopPx)));
  const bottom = Math.max(
    0,
    Math.min(bitmap.height - top - 1, Math.round(cropBottomPx))
  );
  const srcH = Math.max(1, bitmap.height - top - bottom);
  const srcW = bitmap.width;
  const scale = Math.min(1, targetWidth / Math.max(1, srcW));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, top, srcW, srcH, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = g;
    d[i + 1] = g;
    d[i + 2] = g;
  }
  ctx.putImageData(imageData, 0, 0);
  bitmap.close?.();
  const out = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: JPEG_QUALITY,
  });
  const buf = await out.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = btoa(binary);
  return {
    dataBase64: `data:image/jpeg;base64,${b64}`,
    width: w,
    height: h,
    byteSize: bytes.length,
  };
}

/** Scroll to y, wait until motion stops, then wait POST_SCROLL_DELAY_MS. */
async function scrollSettleAndDelay(tabId, frameId, y) {
  const res = await sendToTab(
    tabId,
    { type: "CAPTURE_SCROLL_TO", y, waitSettle: true },
    frameId
  );
  await sleep(POST_SCROLL_DELAY_MS);
  return res;
}

/**
 * Overlap step from the pinned scroll root's viewport.
 * step = 90% of vh → consecutive shots share ~10% of viewport height.
 */
function overlapStepPx(viewportH) {
  const vh = Math.max(200, Number(viewportH) || 800);
  return Math.max(1, Math.floor(vh * SCROLL_STEP_RATIO));
}

/**
 * Full pipeline (one user click):
 * scroll topâ†’bottom â†’ buffer each slice â†’ upload â†’ signal content to resume submit.
 */
async function runSubmitCapture(tabId, meta = {}) {
  const settings = await getSettings();
  if (!settings.consentAccepted || !settings.captureEnabled) {
    return { ok: false, error: "Capture is disabled. Enable it in the extension." };
  }
  const tab = await chrome.tabs.get(tabId);
  const tabUrl = normalizeCaptureUrl(tab.url || meta.url || "");
  if (!hostAllowed(tabUrl, settings.allowedHosts)) {
    return { ok: false, error: "This site is not in the allowed host list." };
  }
  if (!settings.apiKey?.trim()) {
    return { ok: false, error: "API key not configured. Open Options." };
  }
  if (capturingTabs.has(tabId) || (await isUrlBusy(tabUrl))) {
    return { ok: false, error: "Capture already in progress for this page." };
  }

  capturingTabs.add(tabId);
  const clientCaptureId =
    crypto.randomUUID?.() ||
    `cap_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const pageTitle = meta.pageTitle || tab.title || "";

  try {
    await beginCaptureSession({
      url: tabUrl,
      pageTitle,
      clientCaptureId,
    });

    await broadcastToTab(tabId, {
      type: "CAPTURE_STATUS",
      text: "Scrolling & capturing…",
      tone: "info",
    });

    // Probe every frame for a root that actually moves, then keep it pinned.
    let target = await pickBestScrollTarget(tabId);
    if (!target) {
      await setCaptureSessionStatus(tabUrl, "failed", {
        uploadError: "Could not reach the page",
      });
      return { ok: false, error: "Could not reach the page. Refresh and try again." };
    }
    let scrollFrameId = target.frameId;

    let viewportH = Math.max(200, Number(target.viewportH) || 800);
    let step = overlapStepPx(viewportH);
    let maxScroll = Math.max(0, Number(target.maxScroll) || 0);
    let reprobed = false;

    await broadcastToTab(tabId, {
      type: "CAPTURE_STATUS",
      text: `${target.scrollLevel || (target.rootIsWindow ? "browser" : "dom")} · vh=${Math.round(viewportH)} step=${step} max=${Math.round(maxScroll)} · 10% overlap…`,
      tone: "info",
    });

    const windowId = tab.windowId;
    const images = [];
    let y = 0;
    let lastCapturedY = -9999;

    try {
      // Incremental: y = 0, step, 2*step, …, maxScroll (exact 90% advances).
      for (let i = 0; i < MAX_SLICES; i++) {
        await scrollSettleAndDelay(tabId, scrollFrameId, y);

        let actualY = y;
        try {
          const live = await sendToTab(
            tabId,
            { type: "CAPTURE_SCROLL_METRICS" },
            scrollFrameId
          );
          if (live?.ok) {
            actualY = Math.round(Number(live.scrollY) || y);
            const liveVh = Math.max(200, Number(live.viewportH) || viewportH);
            const liveMax = Math.max(0, Number(live.maxScroll) || 0);
            if (liveMax > maxScroll) maxScroll = liveMax;
            if (liveVh > 0 && Math.abs(liveVh - viewportH) > 40 && i === 0) {
              viewportH = liveVh;
              step = overlapStepPx(viewportH);
            }
          }
        } catch {
          // ignore
        }

        // Stuck at y≈0 while we expected to scroll → wrong root; re-probe once.
        if (
          !reprobed &&
          i >= 1 &&
          y > 40 &&
          actualY < 10 &&
          maxScroll > step
        ) {
          reprobed = true;
          try {
            const again = await sendToTab(
              tabId,
              { type: "CAPTURE_REPROBE_SCROLL_ROOT" },
              scrollFrameId
            );
            if (again?.ok) {
              viewportH = Math.max(200, Number(again.viewportH) || viewportH);
              step = overlapStepPx(viewportH);
              maxScroll = Math.max(maxScroll, Number(again.maxScroll) || 0);
              y = 0;
              lastCapturedY = -9999;
              await broadcastToTab(tabId, {
                type: "CAPTURE_STATUS",
                text: `Re-probed scroller · vh=${Math.round(viewportH)} step=${step}…`,
                tone: "warn",
              });
              continue;
            }
          } catch {
            // ignore
          }
        }

        // Same position as last shot (stuck at bottom) → stop after capturing once.
        if (Math.abs(actualY - lastCapturedY) <= 2 && images.length) {
          break;
        }

        if (i > 0) await sleep(CAPTURE_GAP_MS);
        const raw = await captureVisibleJpeg(windowId);
        const processed = await processSlice(raw);
        const slice = {
          sortOrder: images.length,
          dataBase64: processed.dataBase64,
          width: processed.width,
          height: processed.height,
        };
        images.push(slice);
        lastCapturedY = actualY;
        await appendCaptureSlice(tabUrl, slice);

        const totalHint = Math.max(
          images.length,
          maxScroll > 0 ? Math.ceil(maxScroll / step) + 1 : 1
        );
        await broadcastToTab(tabId, {
          type: "CAPTURE_STATUS",
          text: `Captured ${images.length}/${totalHint} · y=${actualY} step=${step}`,
          tone: "info",
        });

        try {
          chrome.runtime.sendMessage({
            type: "BUFFER_CAPTURE_PROGRESS",
            url: tabUrl,
            sliceCount: images.length,
            totalHint,
          });
        } catch {
          // no UI listeners
        }

        // Finished bottom slice (or page fits in one viewport).
        if (maxScroll <= 1 || actualY >= maxScroll - 1) break;

        const nextY = Math.min(maxScroll, actualY + step);
        if (nextY <= actualY + 1) break;
        y = nextY;
      }
    } catch (err) {
      try {
        await sendToTab(tabId, { type: "CAPTURE_RESTORE_SCROLL" }, scrollFrameId);
      } catch {
        // ignore
      }
      try {
        await sendToTab(tabId, { type: "CAPTURE_UNPIN_SCROLL_ROOT" }, scrollFrameId);
      } catch {
        // ignore
      }
      await setCaptureSessionStatus(tabUrl, "failed", {
        uploadError: err?.message || "capture failed",
      });
      return {
        ok: false,
        error: err?.message || "Screenshot capture failed",
      };
    }

    try {
      await sendToTab(tabId, { type: "CAPTURE_RESTORE_SCROLL" }, scrollFrameId);
    } catch {
      // ignore
    }
    try {
      await sendToTab(tabId, { type: "CAPTURE_UNPIN_SCROLL_ROOT" }, scrollFrameId);
    } catch {
      // ignore
    }

    // Upload only after full capture
    await setCaptureSessionStatus(tabUrl, "uploading");
    await broadcastToTab(tabId, {
      type: "CAPTURE_STATUS",
      text: "Uploading screenshots…",
      tone: "info",
    });

    const session = await getCaptureSession(tabUrl);
    const toUpload = session?.images?.length ? session.images : images;

    try {
      const result = await uploadApplicationCapture({
        clientCaptureId,
        tabUrl,
        pageTitle,
        capturedAt: session?.capturedAt || Date.now(),
        images: toUpload,
      });
      // Keep all slices in the local buffer so the side panel can list them.
      await setCaptureSessionStatus(tabUrl, "uploaded", {
        serverSessionId: result?.session?.id || null,
        uploadError: null,
        images: toUpload,
      });
      const state = await getTabState(tabId);
      state.lastCaptureId = result?.session?.id || clientCaptureId;
      state.lastCaptureStatus = "uploaded";
      await setTabState(tabId, state);
      await updateBadge(tabId);

      try {
        chrome.runtime.sendMessage({
          type: "BUFFER_CAPTURE_UPDATED",
          url: tabUrl,
        });
      } catch {
        // ignore
      }

      return {
        ok: true,
        uploaded: true,
        clientCaptureId,
        sliceCount: toUpload.length,
        session: result.session,
      };
    } catch (err) {
      await setCaptureSessionStatus(tabUrl, "failed", {
        uploadError: err?.message || "upload failed",
      });
      return {
        ok: false,
        error: err?.message || "Upload failed",
        captured: true,
        sliceCount: toUpload.length,
      };
    }
  } finally {
    capturingTabs.delete(tabId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId =
    sender.tab?.id ??
    (typeof message?.tabId === "number" ? message.tabId : undefined);

  const reply = async () => {
    if (message?.type === "GET_RECORDING_STATE") {
      const settings = await getSettings();
      // Side panel / popup have no sender.tab — require message.tabId.
      let resolvedTabId = tabId;
      if (resolvedTabId == null && typeof message.tabId === "number") {
        resolvedTabId = message.tabId;
      }
      if (resolvedTabId != null) {
        await reconcileHost(resolvedTabId, message.url || "");
      }
      const state =
        resolvedTabId != null ? await getTabState(resolvedTabId) : null;
      // Prefer the real tab URL for allow-list checks (not iframe href).
      let topUrl = state?.tabUrl || message.url || "";
      if (resolvedTabId != null) {
        try {
          const tab = await chrome.tabs.get(resolvedTabId);
          if (tab?.url) topUrl = tab.url;
        } catch {
          // ignore
        }
      }
      const allowed = hostAllowed(topUrl, settings.allowedHosts);
      return {
        ok: true,
        captureEnabled: Boolean(settings.captureEnabled),
        recordingEnabled: Boolean(settings.captureEnabled), // alias
        consentAccepted: Boolean(settings.consentAccepted),
        paused: Boolean(state?.paused),
        isApplyPage: Boolean(state?.isApplyPage),
        submitCount: state?.submitCount || 0,
        hostAllowed: allowed,
        canCapture:
          settings.captureEnabled &&
          settings.consentAccepted &&
          allowed &&
          !state?.paused,
        lastCaptureId: state?.lastCaptureId || null,
        ownerHint: null,
      };
    }

    if (message?.type === "APPLY_PAGE_DETECTED" && tabId != null) {
      let state = await reconcileHost(tabId, message.url || "");
      let topUrl = state.tabUrl || message.url || "";
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab?.url) topUrl = tab.url;
      } catch {
        // ignore
      }
      state.tabUrl = topUrl || state.tabUrl;
      state.pageTitle = message.pageTitle || state.pageTitle;
      // Multi-frame sticky OR: once Submit is seen on this host, keep Yes.
      // Never flip back to No from a frame that doesn't see the button.
      const found = Boolean(message.isApplyPage);
      const count = Number(message.submitCount) || 0;
      const wasApply = Boolean(state.isApplyPage);
      if (found) {
        state.isApplyPage = true;
        state.submitCount = Math.max(1, Number(state.submitCount) || 0, count);
        state.applyHost = hostOf(topUrl || message.url || state.tabUrl);
      }
      await setTabState(tabId, state);
      await updateBadge(tabId);
      // Only push UI when this tab newly becomes Yes (never broadcast No).
      if (found && !wasApply) {
        try {
          chrome.runtime.sendMessage({
            type: "APPLY_PAGE_STATE",
            tabId,
            isApplyPage: true,
            submitCount: state.submitCount || 0,
            url: state.tabUrl,
          });
        } catch {
          // no UI listeners
        }
      }
      return { ok: true, isApplyPage: state.isApplyPage };
    }

    if (message?.type === "PAUSE_CAPTURE_HOOKS" && tabId != null) {
      await broadcastToTab(tabId, { type: "PAUSE_CAPTURE_HOOKS" });
      return { ok: true };
    }

    if (message?.type === "RESUME_CAPTURE_HOOKS" && tabId != null) {
      await broadcastToTab(tabId, { type: "RESUME_CAPTURE_HOOKS" });
      return { ok: true };
    }

    // Legacy alias
    if (message?.type === "TEARDOWN_CAPTURE_HOOKS" && tabId != null) {
      await broadcastToTab(tabId, { type: "PAUSE_CAPTURE_HOOKS" });
      return { ok: true };
    }

    if (message?.type === "START_SUBMIT_CAPTURE" && tabId != null) {
      const settings = await getSettings();
      const state = await getTabState(tabId);
      if (state.paused) {
        return { ok: false, error: "Capture paused for this tab." };
      }
      if (!settings.captureEnabled || !settings.consentAccepted) {
        return { ok: false, error: "Enable capture + consent in Options." };
      }
      // Clicking Submit proves detection — keep side panel status in sync.
      state.isApplyPage = true;
      state.submitCount = Math.max(1, Number(state.submitCount) || 0);
      state.tabUrl = message.url || state.tabUrl;
      state.pageTitle = message.pageTitle || state.pageTitle;
      state.applyHost = hostOf(message.url || state.tabUrl);
      await setTabState(tabId, state);
      await updateBadge(tabId);
      try {
        chrome.runtime.sendMessage({
          type: "APPLY_PAGE_STATE",
          tabId,
          isApplyPage: true,
          submitCount: state.submitCount,
          url: state.tabUrl,
        });
      } catch {
        // ignore
      }
      return runSubmitCapture(tabId, {
        url: message.url,
        pageTitle: message.pageTitle,
      });
    }

    if (message?.type === "UI_ACTION") {
      const action = message.action;
      const targetTabId = message.tabId;
      const settings = await getSettings();

      if (action === "toggle_capture" || action === "toggle_recording") {
        await chrome.storage.sync.set({
          captureEnabled: !settings.captureEnabled,
          recordingEnabled: !settings.captureEnabled,
        });
        if (targetTabId != null) await updateBadge(targetTabId);
        return { ok: true, captureEnabled: !settings.captureEnabled };
      }
      if (action === "pause_tab" && targetTabId != null) {
        const st = await getTabState(targetTabId);
        st.paused = true;
        await setTabState(targetTabId, st);
        await updateBadge(targetTabId);
        return { ok: true };
      }
      if (action === "resume_tab" && targetTabId != null) {
        const st = await getTabState(targetTabId);
        st.paused = false;
        await setTabState(targetTabId, st);
        await updateBadge(targetTabId);
        return { ok: true };
      }
      if (action === "get_me") {
        try {
          const me = await fetchMe();
          return { ok: true, me };
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
      }
      if (action === "list_captures") {
        try {
          const data = await listCaptures({
            page: message.page || 1,
            limit: message.limit || 10,
          });
          return { ok: true, ...data };
        } catch (err) {
          return { ok: false, error: err?.message || String(err) };
        }
      }
      if (action === "list_buffer_sessions") {
        const sessions = await listCaptureSessions();
        return {
          ok: true,
          sessions: sessions.map((s) => ({
            url: s.url,
            pageTitle: s.pageTitle,
            status: s.status,
            sliceCount: s.images?.length || 0,
            capturedAt: s.capturedAt,
            updatedAt: s.updatedAt,
            clientCaptureId: s.clientCaptureId,
            serverSessionId: s.serverSessionId,
            uploadError: s.uploadError,
            // First-slice thumb for list summary; full images via get_buffer_session
            thumbDataBase64: s.images?.[0]?.dataBase64 || null,
          })),
        };
      }
      if (action === "get_buffer_session") {
        const session = await getCaptureSession(message.url || "");
        if (!session) return { ok: false, error: "Session not found" };
        return { ok: true, session };
      }
      if (action === "delete_buffer_session") {
        const result = await deleteCaptureSession(message.url || "", {
          force: Boolean(message.force),
        });
        return result;
      }
      if (action === "clear_buffer") {
        const result = await clearCaptureBuffer({
          force: Boolean(message.force),
        });
        return result;
      }
      return { ok: false, error: "unknown_action" };
    }

    return { ok: false, error: "unhandled" };
  };

  reply()
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, error: err?.message || String(err) })
    );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  capturingTabs.delete(tabId);
  void chrome.storage.session.remove(`tab:${tabId}`);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    void reconcileHost(tabId, changeInfo.url).then(() => updateBadge(tabId));
  }
  if (changeInfo.status === "complete") {
    void updateBadge(tabId);
    try {
      chrome.tabs
        .sendMessage(tabId, { type: "FORCE_APPLY_SCAN" })
        .catch(() => {});
    } catch {
      // ignore
    }
  }
  void tab;
});
