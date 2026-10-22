import {
  getSettings,
  setSettings,
  normalizeSubmitButtonTexts,
  DEFAULT_SUBMIT_BUTTON_TEXTS,
} from "./lib/storage.js";
import { fetchMe } from "./lib/api.js";

const els = {
  consentAccepted: document.getElementById("consentAccepted"),
  apiBaseUrl: document.getElementById("apiBaseUrl"),
  apiKey: document.getElementById("apiKey"),
  allowedHosts: document.getElementById("allowedHosts"),
  captureEnabled: document.getElementById("captureEnabled"),
  submitTextsList: document.getElementById("submitTextsList"),
  submitTextNew: document.getElementById("submitTextNew"),
  submitTextAdd: document.getElementById("submitTextAdd"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  message: document.getElementById("message"),
};

/** In-memory working copy for the options form. */
let submitTexts = DEFAULT_SUBMIT_BUTTON_TEXTS.slice();

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

function readListFromDom() {
  const inputs = els.submitTextsList.querySelectorAll("input[data-submit-text]");
  return Array.from(inputs).map((input) => input.value);
}

function renderSubmitTexts() {
  els.submitTextsList.replaceChildren();
  submitTexts.forEach((text, index) => {
    const li = document.createElement("li");

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 120;
    input.value = text;
    input.dataset.submitText = "1";
    input.dataset.index = String(index);
    input.setAttribute("aria-label", `Submit button text ${index + 1}`);
    input.addEventListener("change", () => {
      const next = readListFromDom();
      next[index] = input.value;
      submitTexts = normalizeSubmitButtonTexts(next);
      renderSubmitTexts();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "Delete";
    del.disabled = submitTexts.length <= 1;
    del.title =
      submitTexts.length <= 1
        ? "At least one label is required"
        : "Remove this label";
    del.addEventListener("click", () => {
      if (submitTexts.length <= 1) return;
      const next = readListFromDom().filter((_, i) => i !== index);
      submitTexts = normalizeSubmitButtonTexts(next);
      renderSubmitTexts();
    });

    li.append(input, del);
    els.submitTextsList.append(li);
  });
}

function addSubmitText() {
  const value = String(els.submitTextNew.value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) {
    showMessage("Enter a label to add.", false);
    return;
  }
  const next = normalizeSubmitButtonTexts([...readListFromDom(), value]);
  if (next.length === submitTexts.length) {
    showMessage(`“${value}” is already in the list.`, false);
    return;
  }
  submitTexts = next;
  els.submitTextNew.value = "";
  renderSubmitTexts();
  showMessage(`Added “${value}”. Click Save to apply.`, true);
}

async function load() {
  const s = await getSettings();
  els.consentAccepted.checked = Boolean(s.consentAccepted);
  els.apiBaseUrl.value = s.apiBaseUrl || "";
  els.apiKey.value = s.apiKey || "";
  els.allowedHosts.value = (s.allowedHosts || []).join("\n");
  els.captureEnabled.checked = Boolean(s.captureEnabled || s.recordingEnabled);
  submitTexts = normalizeSubmitButtonTexts(s.submitButtonTexts);
  renderSubmitTexts();
}

els.submitTextAdd.addEventListener("click", () => addSubmitText());
els.submitTextNew.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addSubmitText();
  }
});

els.save.addEventListener("click", async () => {
  try {
    const on = els.captureEnabled.checked;
    submitTexts = normalizeSubmitButtonTexts(readListFromDom());
    renderSubmitTexts();
    await setSettings({
      consentAccepted: els.consentAccepted.checked,
      apiBaseUrl: els.apiBaseUrl.value.trim(),
      apiKey: els.apiKey.value.trim(),
      allowedHosts: parseHosts(els.allowedHosts.value),
      captureEnabled: on,
      recordingEnabled: on,
      submitButtonTexts: submitTexts,
    });
    showMessage("Settings saved. Detection list updated on open pages.", true);
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
