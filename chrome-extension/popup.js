const els = {
  statusLine: document.getElementById("statusLine"),
  submitDetected: document.getElementById("submitDetected"),
  btnToggle: document.getElementById("btnToggle"),
  openOptions: document.getElementById("openOptions"),
  error: document.getElementById("error"),
};

function showError(msg) {
  els.error.hidden = !msg;
  els.error.textContent = msg || "";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  showError("");
  const tab = await activeTab();
  const state = await chrome.runtime.sendMessage({
    type: "GET_RECORDING_STATE",
    url: tab?.url || "",
    tabId: tab?.id,
  });
  const on = Boolean(state?.captureEnabled || state?.recordingEnabled);
  els.btnToggle.textContent = on ? "On" : "Off";
  els.btnToggle.className = `toggle ${on ? "on" : "off"}`;

  if (els.submitDetected) {
    if (state?.isApplyPage) {
      els.submitDetected.textContent = `Yes (${state.submitCount || 1})`;
      els.submitDetected.className = "yes";
    } else {
      els.submitDetected.textContent = "No";
      els.submitDetected.className = "no";
    }
  }

  if (!on) {
    els.statusLine.textContent = "Capture is off";
    els.statusLine.className = "status off";
  } else if (state?.isApplyPage) {
    els.statusLine.textContent = "Ready — Submit captures, then submits";
    els.statusLine.className = "status ready";
  } else {
    els.statusLine.textContent = "Waiting for Submit";
    els.statusLine.className = "status off";
  }
}

els.btnToggle.addEventListener("click", async () => {
  const tab = await activeTab();
  await chrome.runtime.sendMessage({
    type: "UI_ACTION",
    action: "toggle_capture",
    tabId: tab?.id,
  });
  await refresh();
});

els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void refresh().catch((err) => showError(err?.message || String(err)));
