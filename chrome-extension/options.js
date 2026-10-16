import { getSettings, setSettings } from "./lib/storage.js";
import { fetchMe } from "./lib/api.js";

const els = {
  consentAccepted: document.getElementById("consentAccepted"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  allowedHosts: document.getElementById("allowedHosts"),
  recordingEnabled: document.getElementById("recordingEnabled"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  message: document.getElementById("message"),
};

function parseHosts(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((h) => h.replace(/^\*\./, ""));
}

function showMessage(text, ok) {
  els.message.hidden = !text;
  els.message.textContent = text || "";
  els.message.className = `message ${ok ? "ok" : "err"}`;
}

async function load() {
  const s = await getSettings();
  els.consentAccepted.checked = Boolean(s.consentAccepted);
  els.apiBaseUrl.value = s.apiBaseUrl || "";
  els.apiKey.value = s.apiKey || "";
  els.allowedHosts.value = (s.allowedHosts || []).join("\n");
  els.recordingEnabled.checked = Boolean(s.recordingEnabled);
}

els.save.addEventListener("click", async () => {
  try {
    await setSettings({
      consentAccepted: els.consentAccepted.checked,
      apiBaseUrl: els.apiBaseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
      allowedHosts: parseHosts(els.allowedHosts.value),
      recordingEnabled: els.recordingEnabled.checked,
    });
    showMessage("Settings saved.", true);
  } catch (err) {
    showMessage(err.message || String(err), false);
  }
});

els.test.addEventListener("click", async () => {
  try {
    await setSettings({
      apiBaseUrl: els.apiBaseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
    });
    const me = await fetchMe();
    showMessage(`Connected as ${me.user.email} (${me.user.id})`, true);
  } catch (err) {
    showMessage(err.message || String(err), false);
  }
});

void load();
