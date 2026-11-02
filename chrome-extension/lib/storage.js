/** Default include-match labels for application-page detection. */
export const DEFAULT_EMAIL_FIELD_TEXTS = ["Email", "E-mail"];
export const DEFAULT_RESUME_FIELD_TEXTS = ["Resume", "CV"];
export const DEFAULT_SUBMIT_BUTTON_TEXTS = ["Submit", "Apply", "Send"];

/**
 * Trim, collapse whitespace, drop empties, dedupe case-insensitively.
 * Falls back to `fallback` when the result would be empty.
 */
export function normalizeAllowList(list, fallback) {
  const defaults = Array.isArray(fallback) && fallback.length
    ? fallback.slice()
    : ["Submit"];
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
  return out.length ? out : defaults;
}

/** @deprecated Prefer normalizeAllowList(..., DEFAULT_SUBMIT_BUTTON_TEXTS) */
export function normalizeSubmitButtonTexts(list) {
  return normalizeAllowList(list, DEFAULT_SUBMIT_BUTTON_TEXTS);
}

const DEFAULTS = {
  apiBaseUrl: "http://31.44.7.64:5000",
  apiKey: "",
  /** @deprecated rrweb removed — always false. */
  captureEnabled: false,
  /** @deprecated rrweb removed — always false. */
  recordingEnabled: false,
  /**
   * Intercept Submit/Apply/Send and require a screenshot upload
   * (or "not an apply page" bypass) before the site click continues.
   */
  applyGateEnabled: true,
  consentAccepted: false,
  /** @deprecated Unused — all http(s) tabs are recorded when captureEnabled. */
  allowedHosts: [],
  /** Include-match labels for email field detection. */
  emailFieldTexts: DEFAULT_EMAIL_FIELD_TEXTS.slice(),
  /** Include-match labels for resume / CV upload detection. */
  resumeFieldTexts: DEFAULT_RESUME_FIELD_TEXTS.slice(),
  /** Include-match labels for submit button detection. */
  submitButtonTexts: DEFAULT_SUBMIT_BUTTON_TEXTS.slice(),
};

export async function getSettings() {
  const data = await chrome.storage.sync.get(DEFAULTS);
  const merged = { ...DEFAULTS, ...data };
  if (data.captureEnabled == null && data.recordingEnabled != null) {
    merged.captureEnabled = Boolean(data.recordingEnabled);
  }
  merged.emailFieldTexts = normalizeAllowList(
    merged.emailFieldTexts,
    DEFAULT_EMAIL_FIELD_TEXTS
  );
  merged.resumeFieldTexts = normalizeAllowList(
    merged.resumeFieldTexts,
    DEFAULT_RESUME_FIELD_TEXTS
  );
  merged.submitButtonTexts = normalizeAllowList(
    merged.submitButtonTexts,
    DEFAULT_SUBMIT_BUTTON_TEXTS
  );
  return merged;
}

export async function setSettings(partial) {
  const next = { ...partial };
  if (Object.prototype.hasOwnProperty.call(partial, "emailFieldTexts")) {
    next.emailFieldTexts = normalizeAllowList(
      partial.emailFieldTexts,
      DEFAULT_EMAIL_FIELD_TEXTS
    );
  }
  if (Object.prototype.hasOwnProperty.call(partial, "resumeFieldTexts")) {
    next.resumeFieldTexts = normalizeAllowList(
      partial.resumeFieldTexts,
      DEFAULT_RESUME_FIELD_TEXTS
    );
  }
  if (Object.prototype.hasOwnProperty.call(partial, "submitButtonTexts")) {
    next.submitButtonTexts = normalizeAllowList(
      partial.submitButtonTexts,
      DEFAULT_SUBMIT_BUTTON_TEXTS
    );
  }
  if (Object.prototype.hasOwnProperty.call(partial, "captureEnabled")) {
    next.recordingEnabled = Boolean(partial.captureEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(partial, "recordingEnabled")) {
    next.captureEnabled = Boolean(partial.recordingEnabled);
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
      /** Shared apply-attempt id across URL hops / related tabs. */
      clientSessionId: null,
      /** Server RrwebSession.id once started. */
      serverSessionId: null,
      recording: false,
      paused: false,
      tabUrl: "",
      pageTitle: "",
      isApplyPage: false,
      hasEmail: false,
      hasResumeUpload: false,
      hasSubmit: false,
      submitCount: 0,
      applyHost: null,
      lastUploadStatus: null,
      eventCount: 0,
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

export function newClientSessionId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `rrweb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Normalize one allowlist entry (host or URL prefix).
 * @returns {{ kind: 'host', host: string } | { kind: 'prefix', prefix: string } | null}
 */
export function normalizeAllowlistEntry(raw) {
  const entry = String(raw || "").trim();
  if (!entry) return null;

  // Full URL / URL prefix
  if (/^https?:\/\//i.test(entry)) {
    try {
      const u = new URL(entry);
      const prefix = `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
      return { kind: "prefix", prefix };
    } catch {
      return null;
    }
  }

  // Bare host (optionally with path): jobs.ashbyhq.com or jobs.ashbyhq.com/company
  const cleaned = entry.replace(/^\*\./, "").toLowerCase();
  const slash = cleaned.indexOf("/");
  if (slash >= 0) {
    const host = cleaned.slice(0, slash);
    const path = cleaned.slice(slash).replace(/\/$/, "") || "";
    if (!host) return null;
    return { kind: "prefix", prefix: `https://${host}${path}` };
  }
  if (!cleaned) return null;
  return { kind: "host", host: cleaned };
}

/**
 * True when `pageUrl` may be recorded against the allowlist.
 * Empty list → false (must configure URLs to record).
 *
 * Path prefixes match deeper routes, e.g. allowlist
 * `…/o/senior-qa-engineer` also matches `…/o/senior-qa-engineer/c/new`.
 */
export function urlAllowed(pageUrl, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(String(pageUrl || "").trim());
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return false;

  const host = parsed.hostname.toLowerCase();
  const pagePath = parsed.pathname.replace(/\/$/, "").toLowerCase() || "";
  const pageOriginPath =
    `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "").toLowerCase();

  return allowedHosts.some((raw) => {
    const rule = normalizeAllowlistEntry(raw);
    if (!rule) return false;

    if (rule.kind === "host") {
      return host === rule.host || host.endsWith(`.${rule.host}`);
    }

    let ruleUrl;
    try {
      ruleUrl = new URL(
        rule.prefix.includes("://") ? rule.prefix : `https://${rule.prefix}`
      );
    } catch {
      return false;
    }

    const ruleHost = ruleUrl.hostname.toLowerCase();
    const rulePath = ruleUrl.pathname.replace(/\/$/, "").toLowerCase() || "";

    // Host must match (or page host is a subdomain of the rule host).
    const hostOk = host === ruleHost || host.endsWith(`.${ruleHost}`);
    if (!hostOk) return false;

    // Exact path, or a deeper path under the allowlisted prefix.
    // "" rule path = whole host already allowed via host match above when path empty.
    if (!rulePath) return true;
    if (pagePath === rulePath) return true;
    if (pagePath.startsWith(`${rulePath}/`)) return true;

    // Fallback: full origin+path prefix (scheme-sensitive entries).
    const ruleOriginPath =
      `${ruleUrl.origin}${ruleUrl.pathname}`.replace(/\/$/, "").toLowerCase();
    return (
      pageOriginPath === ruleOriginPath ||
      pageOriginPath.startsWith(`${ruleOriginPath}/`)
    );
  });
}

/** Same origin (scheme+host+port) — used to keep recording across in-app redirects. */
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** @deprecated use urlAllowed */
export function hostAllowed(url, allowedHosts) {
  return urlAllowed(url, allowedHosts);
}
