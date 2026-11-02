const els = {
  recPanel: document.getElementById("recPanel"),
  recLabel: document.getElementById("recLabel"),
  statusLine: document.getElementById("statusLine"),
  btnToggle: document.getElementById("btnToggle"),
  openOptions: document.getElementById("openOptions"),
  error: document.getElementById("error"),
};

function showError(msg) {
  els.error.hidden = !msg;
  els.error.textContent = msg || "";
}

function paint(state = {}) {
  const on = state.applyGateEnabled !== false;
  els.btnToggle.textContent = on ? "On" : "Off";
  els.btnToggle.className = `toggle ${on ? "on" : "off"}`;
  els.recPanel.className = `rec-panel phase-${on ? "recording" : "off"}`;
  els.recLabel.textContent = on
    ? "Screenshot gate On"
    : "Screenshot gate Off";
  els.statusLine.textContent = on
    ? "Submit / Apply / Send will ask for a screenshot first."
    : "Gate off — site clicks are not intercepted.";
}

async function refresh() {
  showError("");
  const state = await chrome.runtime.sendMessage({ type: "GET_GATE_STATE" });
  paint(state || {});
}

els.btnToggle.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "UI_ACTION",
    action: "toggle_apply_gate",
  });
  await refresh();
});

els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void refresh().catch((err) => showError(err?.message || String(err)));
