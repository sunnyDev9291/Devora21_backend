const DEFAULTS = {
  apiBaseUrl: "http://31.44.7.64:5000",
  apiKey: "",
  recordingEnabled: false,
  consentAccepted: false,
  /**
   * Optional host restrict list.
   * Empty = record on ANY site (any career/ATS/company apply page).
   * Non-empty = only those hosts (and subdomains).
   */
  allowedHosts: [],
};

export async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...data };
}

export async function setSettings(partial) {
  await chrome.storage.sync.set(partial);
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
      pairs: {},
      /** Sticky: set once email + resume upload are both seen on this tab. */
      isApplyPage: false,
      applyHost: null,
      hasEmail: false,
      hasResumeUpload: false,
      /** Local Q&A buffer exists before Apply Page; flushed on detect. */
      flushedOnce: false,
      /** elementKey → { question, confidence } from DeepSeek match. */
      matchCache: {},
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

/**
 * Empty allowlist → all http(s) pages are eligible.
 * Filled allowlist → optional restrict mode only.
 */
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
