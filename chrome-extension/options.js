import { getSettings, setSettings } from "./lib/storage.js";
import { fetchMe } from "./lib/api.js";

const els = {
  consentAccepted: document.getElementById("consentAccepted"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  applyGateEnabled: document.getElementById("applyGateEnabled"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  message: document.getElementById("message"),
};

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
  els.applyGateEnabled.checked = s.applyGateEnabled !== false;
}

els.save.addEventListener("click", async () => {
  try {
    const gate = els.applyGateEnabled.checked;
    await setSettings({
      consentAccepted: els.consentAccepted.checked,
      apiBaseUrl: els.apiBaseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
      applyGateEnabled: gate,
      captureEnabled: false,
      recordingEnabled: false,
    });
    showMessage(
      `Saved. Apply screenshot gate ${gate ? "On" : "Off"}.`,
      true
    );
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
    const email = me?.user?.email || me?.email || "ok";
    showMessage(`Connected as ${email}`, true);
  } catch (err) {
    showMessage(err.message || String(err), false);
  }
});

void load();
