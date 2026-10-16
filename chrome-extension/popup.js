import { getSettings, getTabState, hostAllowed } from "./lib/storage.js";
import { fetchMe } from "./lib/api.js";

const els = {
  statusLine: document.getElementById("statusLine"),
  ownerEmail: document.getElementById("ownerEmail"),
  tabHost: document.getElementById("tabHost"),
  applyPage: document.getElementById("applyPage"),
  applySignals: document.getElementById("applySignals"),
  hostAllowed: document.getElementById("hostAllowed"),
  pairCount: document.getElementById("pairCount"),
  btnToggle: document.getElementById("btnToggle"),
  btnPause: document.getElementById("btnPause"),
  btnResume: document.getElementById("btnResume"),
  btnClear: document.getElementById("btnClear"),
  openOptions: document.getElementById("openOptions"),
  error: document.getElementById("error"),
};

function showError(msg) {
  if (!msg) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = msg;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function forceScan(tabId, tabUrl) {
  if (tabId == null) return;
  try {
    // Inject detector into all frames (ATS forms are often inside iframes).
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

    await chrome.runtime.sendMessage({
      type: "APPLY_PAGE_DETECTED",
      tabId,
      url: tabUrl || "",
      pageTitle: "",
      hasEmail,
      hasResumeUpload,
    });

    // Also nudge already-injected content scripts (keeps listeners warm).
    try {
      await chrome.tabs.sendMessage(tabId, { type: "FORCE_APPLY_SCAN" });
    } catch {
      // ok
    }
  } catch {
    // Restricted page (chrome://) or blocked — ignore.
  }
}

async function refresh() {
  showError("");
  const settings = await getSettings();
  const tab = await activeTab();
  const tabId = tab?.id;
  const url = tab?.url || "";
  let host = "—";
  try {
    host = new URL(url).hostname;
  } catch {
    host = url || "—";
  }

  await forceScan(tabId, url);

  const restrictList = settings.allowedHosts || [];
  const allowed = hostAllowed(url, restrictList);
  const state =
    tabId != null
      ? await getTabState(tabId)
      : {
          pairs: {},
          paused: false,
          isApplyPage: false,
          hasEmail: false,
          hasResumeUpload: false,
        };
  const count = Object.keys(state.pairs || {}).length;
  const isApplyPage = Boolean(state.isApplyPage);

  els.tabHost.textContent = host;
  els.applyPage.textContent = isApplyPage
    ? "yes · syncing to backend"
    : count > 0
      ? "no · buffering locally"
      : "no · waiting";
  els.applySignals.textContent = `email:${state.hasEmail ? "✓" : "–"} resume:${
    state.hasResumeUpload ? "✓" : "–"
  }`;
  els.hostAllowed.textContent =
    restrictList.length === 0
      ? "all sites"
      : allowed
        ? "allowed"
        : "blocked by list";
  els.pairCount.textContent = String(count);

  const canWork =
    settings.recordingEnabled && settings.consentAccepted && allowed && !state.paused;

  els.statusLine.className = "status";
  if (!settings.consentAccepted) {
    els.statusLine.textContent = "Consent required — open Options";
    els.statusLine.classList.add("off");
  } else if (!settings.recordingEnabled) {
    els.statusLine.textContent = "Recording off";
    els.statusLine.classList.add("off");
  } else if (!allowed) {
    els.statusLine.textContent = "This host is outside your restrict list";
    els.statusLine.classList.add("off");
  } else if (state.paused) {
    els.statusLine.textContent = "Paused on this tab";
    els.statusLine.classList.add("paused");
  } else if (isApplyPage && canWork) {
    els.statusLine.textContent = "Apply Page · syncing buffer to backend";
    els.statusLine.classList.add("on");
  } else if (canWork) {
    els.statusLine.textContent =
      count > 0
        ? `Buffering ${count} field(s) · waiting for email + resume`
        : "Buffering on · waiting for Apply Page (email + resume)";
    els.statusLine.classList.add("paused");
  }

  els.btnToggle.textContent = settings.recordingEnabled
    ? "Disable recording"
    : "Enable recording";

  try {
    if (settings.apiKey) {
      const me = await fetchMe();
      els.ownerEmail.textContent = me?.user?.email || me?.user?.id || "—";
    } else {
      els.ownerEmail.textContent = "API key missing";
    }
  } catch (err) {
    els.ownerEmail.textContent = "Auth failed";
    showError(err.message || String(err));
  }
}

async function sendAction(action) {
  const tab = await activeTab();
  await chrome.runtime.sendMessage({
    type: "POPUP_ACTION",
    action,
    tabId: tab?.id,
  });
  await refresh();
}

els.btnToggle.addEventListener("click", () => sendAction("toggle_recording"));
els.btnPause.addEventListener("click", () => sendAction("pause"));
els.btnResume.addEventListener("click", () => sendAction("resume"));
els.btnClear.addEventListener("click", () => sendAction("clear_tab"));
els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void refresh();
