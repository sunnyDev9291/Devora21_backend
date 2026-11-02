/**
 * Devora21 extension background — apply screenshot gate only (rrweb removed).
 */
import { getSettings, setSettings } from "./lib/storage.js";
import { fetchMe, createApplicationCapture } from "./lib/api.js";

async function updateActionBadge() {
  try {
    const settings = await getSettings();
    const gate = settings.applyGateEnabled !== false;
    await chrome.action.setBadgeText({ text: gate ? "ON" : "" });
    await chrome.action.setBadgeBackgroundColor({
      color: gate ? "#3ecf8e" : "#666666",
    });
    await chrome.action.setTitle({
      title: gate
        ? "Devora21 — Apply screenshot gate On"
        : "Devora21 — Apply screenshot gate Off",
    });
  } catch {
    // ignore
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // ignore
  }
  await updateActionBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateActionBadge().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.applyGateEnabled) {
    updateActionBadge().catch(() => {});
  }
});

updateActionBadge().catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!msg || typeof msg !== "object") {
      sendResponse({ ok: false });
      return;
    }

    if (msg.type === "GET_GATE_STATE") {
      const settings = await getSettings();
      sendResponse({
        ok: true,
        applyGateEnabled: settings.applyGateEnabled !== false,
        hasApiKey: Boolean(settings.apiKey?.trim()),
        apiBaseUrl: settings.apiBaseUrl || "",
      });
      return;
    }

    if (msg.type === "UI_ACTION") {
      const action = msg.action;
      if (action === "toggle_apply_gate") {
        const settings = await getSettings();
        const next = settings.applyGateEnabled === false;
        await setSettings({ applyGateEnabled: next });
        await updateActionBadge();
        sendResponse({ ok: true, applyGateEnabled: next });
        return;
      }
      if (action === "fetch_me") {
        try {
          const me = await fetchMe();
          sendResponse({ ok: true, me });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return;
      }
      sendResponse({ ok: false, error: `Unknown action: ${action}` });
      return;
    }

    if (msg.type === "UPLOAD_APPLY_SCREENSHOT") {
      try {
        const dataBase64 = String(msg.dataBase64 || "");
        if (dataBase64.length < 32) {
          sendResponse({ ok: false, error: "Missing screenshot data" });
          return;
        }
        const res = await createApplicationCapture({
          clientCaptureId: String(msg.clientCaptureId || "").trim(),
          tabUrl: String(msg.tabUrl || sender.tab?.url || "").trim(),
          pageTitle:
            String(msg.pageTitle || sender.tab?.title || "").trim() ||
            undefined,
          capturedAt: msg.capturedAt || Date.now(),
          images: [{ sortOrder: 0, dataBase64 }],
        });
        sendResponse({
          ok: true,
          session: res?.session || null,
          created: res?.created,
        });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
      return;
    }

    /**
     * Child iframe intercepted Submit/Apply/Send — open the gate dialog
     * on the top frame so it covers the full browser viewport.
     */
    if (msg.type === "APPLY_GATE_OPEN_DIALOG") {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "No tab" });
        return;
      }
      const sourceFrameId = sender.frameId ?? 0;
      if (sourceFrameId === 0) {
        // Top frame opens locally; nothing to relay.
        sendResponse({ ok: true, local: true });
        return;
      }
      try {
        await chrome.tabs.sendMessage(
          tabId,
          {
            type: "APPLY_GATE_SHOW_DIALOG",
            sourceFrameId,
            tabUrl: String(msg.tabUrl || sender.tab?.url || "").trim(),
            pageTitle: String(msg.pageTitle || sender.tab?.title || "").trim(),
          },
          { frameId: 0 }
        );
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err?.message || err || "Top frame unavailable"),
        });
      }
      return;
    }

    /**
     * Image pasted in a child frame while the gate dialog is open on top —
     * forward the image into the top-frame dialog.
     */
    if (msg.type === "APPLY_GATE_PASTE_IMAGE") {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "No tab" });
        return;
      }
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          {
            type: "APPLY_GATE_ACCEPT_PASTE",
            dataBase64: msg.dataBase64,
            name: msg.name,
            mimeType: msg.mimeType,
          },
          { frameId: 0 }
        );
        sendResponse(res || { ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err?.message || err || "Paste relay failed"),
        });
      }
      return;
    }

    /**
     * Top-frame dialog finished — resume the original click in the
     * frame that intercepted it.
     */
    if (msg.type === "APPLY_GATE_RESUME") {
      const tabId = sender.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: "No tab" });
        return;
      }
      const targetFrameId = Number(msg.targetFrameId);
      if (!Number.isFinite(targetFrameId) || targetFrameId < 0) {
        sendResponse({ ok: false, error: "Invalid frame" });
        return;
      }
      try {
        const res = await chrome.tabs.sendMessage(
          tabId,
          {
            type: "APPLY_GATE_RESUME",
            action: msg.action,
            respectValidation: false,
          },
          { frameId: targetFrameId }
        );
        sendResponse(res || { ok: true });
      } catch (err) {
        sendResponse({
          ok: false,
          error: String(err?.message || err || "Resume failed"),
        });
      }
      return;
    }

    sendResponse({ ok: false, error: "unknown message" });
  })().catch((err) => {
    try {
      sendResponse({ ok: false, error: String(err?.message || err) });
    } catch {
      // ignore
    }
  });
  return true;
});
