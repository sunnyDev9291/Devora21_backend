import {
  getSettings,
  getTabState,
  setTabState,
  newTabSessionId,
  hostAllowed,
} from "./lib/storage.js";
import { isSensitiveField } from "./lib/sensitive.js";
import { syncApplicationQa } from "./lib/api.js";

const syncTimers = new Map();
const scanTimers = new Map();

/** Always open the extension UI as the Chrome side panel (not a popup). */
async function enableSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.warn("[devora21-qa] sidePanel behavior:", err?.message || err);
  }
}

void enableSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  void enableSidePanelBehavior();
});

function normalizeKey(question) {
  return String(question || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function emptyTabState(tabUrl = "") {
  return {
    tabSessionId: newTabSessionId(),
    paused: false,
    tabUrl: tabUrl || "",
    pageTitle: "",
    pairs: {},
    isApplyPage: false,
    applyHost: null,
    hasEmail: false,
    hasResumeUpload: false,
    flushedOnce: false,
  };
}

/**
 * If the tab navigates to a different host, drop Apply Page + buffer
 * so we don't keep recording unrelated sites in the same tab.
 */
async function reconcileHost(tabId, tabUrl) {
  const state = await getTabState(tabId);
  const host = hostOf(tabUrl);
  const prevHost = state.applyHost || hostOf(state.tabUrl || "");
  if (prevHost && host && host !== prevHost) {
    await setTabState(tabId, emptyTabState(tabUrl));
    return getTabState(tabId);
  }
  return state;
}

async function updateBadge(tabId) {
  const settings = await getSettings();
  const state = await getTabState(tabId);
  const bufCount = Object.keys(state.pairs || {}).length;
  let text = "";
  let color = "#64748b";
  if (!settings.consentAccepted || !settings.recordingEnabled) {
    text = "OFF";
    color = "#64748b";
  } else if (state.paused) {
    text = "❚❚";
    color = "#d97706";
  } else if (state.isApplyPage) {
    text = bufCount > 0 ? String(Math.min(bufCount, 99)) : "REC";
    color = "#0f766e";
  } else if (bufCount > 0) {
    text = String(Math.min(bufCount, 99));
    color = "#0284c7"; // buffering
  } else {
    text = "…";
    color = "#94a3b8";
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // tab may be gone
  }
}

async function ensureTabSession(tabId, tabUrl) {
  let state = await reconcileHost(tabId, tabUrl);
  if (!state.tabSessionId) {
    state.tabSessionId = newTabSessionId();
    state.pairs = state.pairs || {};
  }
  state.tabUrl = tabUrl || state.tabUrl;
  await setTabState(tabId, state);
  return state;
}

function scheduleSync(tabId) {
  if (syncTimers.has(tabId)) clearTimeout(syncTimers.get(tabId));
  syncTimers.set(
    tabId,
    setTimeout(() => {
      syncTimers.delete(tabId);
      void flushSync(tabId);
    }, 350)
  );
}

/** Only sync to backend after Apply Page is confirmed. */
async function flushSync(tabId) {
  const settings = await getSettings();
  if (!settings.recordingEnabled || !settings.consentAccepted) return;
  if (!settings.apiKey?.trim()) return;

  const state = await getTabState(tabId);
  if (!state.isApplyPage) return;
  if (!state.tabSessionId || !state.tabUrl) return;
  if (!hostAllowed(state.tabUrl, settings.allowedHosts)) return;

  const input_events = Object.values(state.pairs || {}).map((p) => ({
    elementKey: p.elementKey || p.question || "",
    value: p.value ?? p.answer ?? "",
    eventType: p.eventType || "input",
    timestamp: p.timestamp || p.updatedAt || Date.now(),
    tagName: p.tagName || "",
    inputType: p.inputType || p.fieldType || "",
    elementId: p.elementId || "",
    name: p.name || p.fieldName || "",
    className: p.className || "",
    cssSelector: p.cssSelector || "",
    attributes: p.attributes || undefined,
    label: p.label || p.question || undefined,
    autocomplete: p.autocomplete || undefined,
  }));

  // Allow empty flush once so session exists; usually has buffered events.
  try {
    await syncApplicationQa({
      tab_url: state.tabUrl,
      tab_session_id: state.tabSessionId,
      page_title: state.pageTitle || undefined,
      status: state.paused ? "paused" : "recording",
      input_events,
    });
    state.flushedOnce = true;
    await setTabState(tabId, state);
  } catch (err) {
    console.warn("[devora21-qa] sync failed:", err?.message || err);
  }
}

/** Scan all frames in a tab for email + resume signals (iframe-safe). */
async function scanTabFrames(tabId, tabUrl) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["lib/detect-apply.js"],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const api = globalThis.Devora21DetectApply;
        if (!api) return null;
        return api.detectApplyPageSignals(document);
      },
    });
    let hasEmail = false;
    let hasResumeUpload = false;
    for (const r of results || []) {
      if (!r?.result) continue;
      if (r.result.hasEmail) hasEmail = true;
      if (r.result.hasResumeUpload) hasResumeUpload = true;
    }
    await applyDetection(tabId, {
      url: tabUrl || "",
      hasEmail,
      hasResumeUpload,
    });
  } catch {
    // Restricted URL / no permission
  }
}

function scheduleFrameScan(tabId, tabUrl) {
  if (scanTimers.has(tabId)) clearTimeout(scanTimers.get(tabId));
  scanTimers.set(
    tabId,
    setTimeout(() => {
      scanTimers.delete(tabId);
      void scanTabFrames(tabId, tabUrl);
    }, 400)
  );
}

async function applyDetection(tabId, message) {
  const settings = await getSettings();
  const tabUrl = message.url || "";
  if (tabUrl && !hostAllowed(tabUrl, settings.allowedHosts)) {
    return { ok: false, reason: "host_blocked" };
  }

  let state = await reconcileHost(tabId, tabUrl);
  const host = hostOf(tabUrl);
  const wasApply = Boolean(state.isApplyPage);

  state.hasEmail = Boolean(message.hasEmail) || Boolean(state.hasEmail);
  state.hasResumeUpload =
    Boolean(message.hasResumeUpload) || Boolean(state.hasResumeUpload);
  state.tabUrl = tabUrl || state.tabUrl;
  state.pageTitle = message.pageTitle || state.pageTitle || "";

  const nowApply =
    state.isApplyPage || (state.hasEmail && state.hasResumeUpload);

  if (!nowApply) {
    await setTabState(tabId, state);
    await updateBadge(tabId);
    return {
      ok: true,
      isApplyPage: false,
      hasEmail: state.hasEmail,
      hasResumeUpload: state.hasResumeUpload,
    };
  }

  if (!state.tabSessionId) {
    state.tabSessionId = newTabSessionId();
    state.pairs = state.pairs || {};
  }
  state.isApplyPage = true;
  state.applyHost = host || state.applyHost || hostOf(state.tabUrl);
  state.hasEmail = true;
  state.hasResumeUpload = true;
  await setTabState(tabId, state);
  await updateBadge(tabId);

  // First latch → flush immediately so Super Admin SSE sees the session now.
  // Later field edits stay debounced via scheduleSync.
  if (!wasApply) {
    void flushSync(tabId);
  }

  return { ok: true, isApplyPage: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId =
    sender.tab?.id ??
    (typeof message?.tabId === "number" ? message.tabId : undefined);
  (async () => {
    if (message?.type === "GET_RECORDING_STATE") {
      const settings = await getSettings();
      // Always use top-level tab URL — iframe URLs (ATS embeds) must not fail host checks.
      const url = sender.tab?.url || message.url || "";
      const allowed = hostAllowed(url, settings.allowedHosts);
      if (tabId != null) await reconcileHost(tabId, url);
      const state = tabId != null ? await getTabState(tabId) : null;
      const isApplyPage = Boolean(state?.isApplyPage);
      const canBuffer =
        settings.recordingEnabled &&
        settings.consentAccepted &&
        allowed &&
        !(state?.paused);
      sendResponse({
        // canBuffer: save locally before Apply Page is confirmed
        canBuffer,
        // enabled: actively syncing (apply page latched)
        enabled: canBuffer && isApplyPage,
        recordingEnabled: settings.recordingEnabled,
        consentAccepted: settings.consentAccepted,
        allowed,
        isApplyPage,
        hasEmail: Boolean(state?.hasEmail),
        hasResumeUpload: Boolean(state?.hasResumeUpload),
        paused: Boolean(state?.paused),
        bufferCount: Object.keys(state?.pairs || {}).length,
      });
      return;
    }

    if (message?.type === "APPLY_PAGE_DETECTED" && tabId != null) {
      // Prefer top-level tab URL so iframe messages don't replace host with frame URL.
      const tabUrl = sender.tab?.url || message.url || "";
      const result = await applyDetection(tabId, {
        url: tabUrl,
        pageTitle: message.pageTitle,
        hasEmail: message.hasEmail,
        hasResumeUpload: message.hasResumeUpload,
      });
      sendResponse(result);
      return;
    }

    if (message?.type === "REQUEST_FRAME_SCAN" && tabId != null) {
      const tabUrl = sender.tab?.url || message.url || "";
      scheduleFrameScan(tabId, tabUrl);
      sendResponse({ ok: true });
      return;
    }

    if (
      (message?.type === "DOM_INPUT_EVENT" ||
        message?.type === "FIELD_CAPTURE") &&
      tabId != null
    ) {
      const settings = await getSettings();
      const tabUrl = sender.tab?.url || message.tabUrl || "";
      if (
        !settings.recordingEnabled ||
        !settings.consentAccepted ||
        !hostAllowed(tabUrl, settings.allowedHosts)
      ) {
        sendResponse({ ok: false, reason: "not_recording" });
        return;
      }

      const state = await ensureTabSession(tabId, tabUrl);
      if (state.paused) {
        sendResponse({ ok: false, reason: "paused" });
        return;
      }

      // New shape: DOM input event. Legacy FIELD_CAPTURE still accepted.
      const elementKey = normalizeKey(
        message.elementKey || message.question || message.fieldName || ""
      );
      const value = String(
        message.value ?? message.answer ?? ""
      );
      if (!elementKey) {
        sendResponse({ ok: false, reason: "empty_element" });
        return;
      }

      if (
        isSensitiveField({
          question: message.label || elementKey,
          fieldType: message.inputType || message.fieldType,
          fieldName: message.name || message.fieldName,
          name: message.name || message.fieldName,
          elementId: message.elementId,
          className: message.className,
          cssSelector: message.cssSelector,
          autocomplete: message.autocomplete,
        })
      ) {
        sendResponse({ ok: false, reason: "sensitive" });
        return;
      }

      state.pairs = state.pairs || {};
      const prior = state.pairs[elementKey];
      // Skip unchanged values (no duplicate buffer / sync noise).
      if (prior && String(prior.value ?? prior.answer ?? "") === value) {
        sendResponse({
          ok: true,
          skippedUnchanged: true,
          count: Object.keys(state.pairs).length,
        });
        return;
      }

      state.pairs[elementKey] = {
        elementKey,
        value,
        eventType: message.eventType || "input",
        timestamp: message.timestamp || Date.now(),
        tagName: message.tagName || "",
        inputType: message.inputType || message.fieldType || "",
        elementId: message.elementId || "",
        name: message.name || message.fieldName || "",
        className: message.className || "",
        cssSelector: message.cssSelector || "",
        attributes: message.attributes || {},
        label: message.label || elementKey,
        autocomplete: message.autocomplete || "",
        updatedAt: Date.now(),
      };
      state.tabUrl = tabUrl;
      state.pageTitle = message.pageTitle || state.pageTitle || "";
      await setTabState(tabId, state);

      if (state.isApplyPage) {
        scheduleSync(tabId);
      }
      await updateBadge(tabId);
      sendResponse({
        ok: true,
        buffered: !state.isApplyPage,
        synced: Boolean(state.isApplyPage),
        count: Object.keys(state.pairs).length,
      });
      return;
    }

    if (message?.type === "POPUP_ACTION") {
      const action = message.action;
      const targetTabId = message.tabId;
      if (action === "toggle_recording") {
        const settings = await getSettings();
        await chrome.storage.sync.set({
          recordingEnabled: !settings.recordingEnabled,
        });
      }
      if (action === "pause" && targetTabId != null) {
        const state = await getTabState(targetTabId);
        state.paused = true;
        await setTabState(targetTabId, state);
        if (state.isApplyPage) scheduleSync(targetTabId);
      }
      if (action === "resume" && targetTabId != null) {
        const state = await getTabState(targetTabId);
        state.paused = false;
        await setTabState(targetTabId, state);
        if (state.isApplyPage) scheduleSync(targetTabId);
      }
      if (action === "clear_tab" && targetTabId != null) {
        await setTabState(targetTabId, emptyTabState());
      }
      if (action === "rescan" && targetTabId != null) {
        const tab = await chrome.tabs.get(targetTabId).catch(() => null);
        await scanTabFrames(targetTabId, tab?.url || "");
      }
      if (targetTabId != null) await updateBadge(targetTabId);
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err?.message || err) });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // Only push to backend if this tab was confirmed as an Apply Page.
  void flushSync(tabId);
  void chrome.storage.session.remove(`tab:${tabId}`);
  if (syncTimers.has(tabId)) {
    clearTimeout(syncTimers.get(tabId));
    syncTimers.delete(tabId);
  }
  if (scanTimers.has(tabId)) {
    clearTimeout(scanTimers.get(tabId));
    scanTimers.delete(tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    void reconcileHost(tabId, changeInfo.url).then(() => updateBadge(tabId));
    scheduleFrameScan(tabId, changeInfo.url);
  }
  if (changeInfo.status === "complete") {
    void updateBadge(tabId);
    scheduleFrameScan(tabId, tab?.url || "");
    // Ensure content script is present in all frames after navigation.
    void chrome.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        files: ["lib/detect-apply.js", "lib/dom-event.js", "content.js"],
      })
      .catch(() => undefined);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") {
    void chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) {
        if (t.id != null) void updateBadge(t.id);
      }
    });
  }
});
