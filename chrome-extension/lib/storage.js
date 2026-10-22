/** Default submit-button detection labels (exact match after normalize). */
export const DEFAULT_SUBMIT_BUTTON_TEXTS = ["Submit"];

/**
 * Trim, collapse whitespace, drop empties, dedupe case-insensitively.
 * Falls back to DEFAULT_SUBMIT_BUTTON_TEXTS when the result would be empty.
 */
export function normalizeSubmitButtonTexts(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const display = String(raw || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!display) continue;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out.length ? out : DEFAULT_SUBMIT_BUTTON_TEXTS.slice();
}

const DEFAULTS = {
  apiBaseUrl: "http://31.44.7.64:5000",
  apiKey: "",
  /** Master switch for Submit → Capture and Submit flow. */
  captureEnabled: false,
  /** Legacy alias kept in sync with captureEnabled. */
  recordingEnabled: false,
  consentAccepted: false,
  /**
   * Optional host restrict list.
   * Empty = any site. Non-empty = only those hosts (and subdomains).
   */
  allowedHosts: [],
  /**
   * Exact-match submit button labels (case-insensitive).
   * Managed in the options UI; consumed by detect-apply.
   */
  submitButtonTexts: DEFAULT_SUBMIT_BUTTON_TEXTS.slice(),
};

export async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  const merged = { ...DEFAULTS, ...data };
  // Prefer captureEnabled; fall back to legacy recordingEnabled once.
  if (data.captureEnabled == null && data.recordingEnabled != null) {
    merged.captureEnabled = Boolean(data.recordingEnabled);
  }
  merged.submitButtonTexts = normalizeSubmitButtonTexts(merged.submitButtonTexts);
  return merged;
}

export async function setSettings(partial) {
  const next = { ...partial };
  if (Object.prototype.hasOwnProperty.call(partial, "submitButtonTexts")) {
    next.submitButtonTexts = normalizeSubmitButtonTexts(partial.submitButtonTexts);
  }
  await chrome.storage.sync.set(next);
  return getSettings();
}

/** Per-tab session state keyed by chrome tabId (session storage). */
export async function getTabState(tabId) {
  const key = `tab:${tabId}`;
  const data = await chrome.storage.session.get(key);
  return (
    data[key] || {
      tabSessionId: null,
      paused: false,
      tabUrl: "",
      pageTitle: "",
      isApplyPage: false,
      submitCount: 0,
      applyHost: null,
      lastCaptureId: null,
      lastCaptureStatus: null,
    }
  );
}

export async function setTabState(tabId, state) {
  const key = `tab:${tabId}`;
  await chrome.storage.session.set({ [key]: state });
}

export function newTabSessionId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function hostAllowed(url, allowedHosts) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
      return true;
    }
    return allowedHosts.some((entry) => {
      const h = String(entry || "")
        .trim()
        .toLowerCase()
        .replace(/^\*\./, "")
        .replace(/^https?:\/\//, "")
        .split("/")[0];
      if (!h) return false;
      return host === h || host.endsWith(`.${h}`);
    });
  } catch {
    return false;
  }
}
