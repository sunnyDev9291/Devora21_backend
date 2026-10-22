/**
 * Application page detection via configurable SUBMIT_BUTTON_TEXTS.
 * Matches visible text / value / aria-label / title exactly (normalized).
 * Marks via data attribute only. Capture-before-submit hooks unchanged.
 *
 * The live list is seeded with ["Submit"] and updated from chrome.storage
 * (options UI) via setSubmitButtonTexts — do not hardcode comparisons elsewhere.
 */
(function (global) {
  const MARK_ATTR = "data-devora21-capture-submit";

  /**
   * Central list of submit-button labels.
   * Default: ["Submit"]. Options UI add/edit/delete updates this at runtime.
   * Matching is case-insensitive exact equality after trim / whitespace collapse.
   */
  const DEFAULT_SUBMIT_BUTTON_TEXTS = ["Submit"];
  const SUBMIT_BUTTON_TEXTS = DEFAULT_SUBMIT_BUTTON_TEXTS.slice();

  function normalizeLabel(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function sanitizeSubmitTexts(list) {
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

  /** Replace the live detection list (from storage / options UI). */
  function setSubmitButtonTexts(list) {
    const cleaned = sanitizeSubmitTexts(list);
    SUBMIT_BUTTON_TEXTS.length = 0;
    for (const t of cleaned) SUBMIT_BUTTON_TEXTS.push(t);
    return SUBMIT_BUTTON_TEXTS.slice();
  }

  function getSubmitButtonTexts() {
    return SUBMIT_BUTTON_TEXTS.slice();
  }

  /** Normalized allowlist — rebuilt from SUBMIT_BUTTON_TEXTS each call. */
  function normalizedSubmitTexts() {
    return SUBMIT_BUTTON_TEXTS.map(normalizeLabel).filter(Boolean);
  }

  /** Exact match against SUBMIT_BUTTON_TEXTS after normalization. */
  function textMatchesSubmitList(raw) {
    const n = normalizeLabel(raw);
    if (!n) return false;
    return normalizedSubmitTexts().includes(n);
  }

  function visibleText(el) {
    try {
      return String(el?.innerText || el?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    } catch {
      return "";
    }
  }

  /**
   * All label-like strings for a control (visible text + relevant attributes).
   * Any one matching SUBMIT_BUTTON_TEXTS counts.
   */
  function controlLabelCandidates(el) {
    if (!el) return [];
    const out = [];
    if (el.tagName === "INPUT") {
      out.push(el.value);
    } else {
      out.push(visibleText(el));
    }
    out.push(el.getAttribute?.("value"));
    out.push(el.getAttribute?.("aria-label"));
    out.push(el.getAttribute?.("title"));
    return out.filter((s) => s != null && String(s).trim() !== "");
  }

  /** Prefer visible text/value; fall back to aria-label / title. */
  function controlLabel(el) {
    const parts = controlLabelCandidates(el);
    return parts.length ? normalizeLabel(parts[0]) : "";
  }

  /** True when normalized label exactly equals an entry in SUBMIT_BUTTON_TEXTS. */
  function isSubmitLabel(label) {
    return textMatchesSubmitList(label);
  }

  /** True when any visible text or relevant attribute matches the list. */
  function controlMatchesSubmitList(el) {
    return controlLabelCandidates(el).some(textMatchesSubmitList);
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.disabled) return false;
      const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
      if (!style) return true;
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect?.();
      if (rect && rect.width < 2 && rect.height < 2) return false;
      return true;
    } catch {
      return true;
    }
  }

  function isRawSubmitCandidate(el) {
    if (!el || el.nodeType !== 1 || el.disabled) return false;
    const tag = el.tagName;
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    const isControl =
      tag === "BUTTON" ||
      tag === "INPUT" ||
      tag === "A" ||
      role === "button";
    if (!isControl) return false;

    const typeAttr = el.getAttribute("type");
    const type = String(
      typeAttr != null && typeAttr !== "" ? typeAttr : el.type || ""
    ).toLowerCase();

    if (type === "reset" || type === "file") return false;

    return controlMatchesSubmitList(el);
  }

  function markPrimarySubmit(el) {
    if (!el) return null;
    el.setAttribute(MARK_ATTR, "1");
    return el;
  }

  function applyCaptureLabel(el) {
    return markPrimarySubmit(el);
  }

  function clearMark(el) {
    if (!el) return;
    el.removeAttribute(MARK_ATTR);
  }

  function restoreOriginalLabel(el) {
    clearMark(el);
  }

  function collectRawCandidates(root = document) {
    const out = [];
    const seen = new Set();
    try {
      root
        .querySelectorAll?.(
          "button, input[type='submit'], input[type='button'], a[role='button'], [role='button']"
        )
        ?.forEach((el) => {
          if (!el || seen.has(el)) return;
          if (!isRawSubmitCandidate(el)) return;
          if (!isVisible(el)) return;
          seen.add(el);
          out.push(el);
        });
    } catch {
      // ignore
    }
    return out;
  }

  function findExistingMarked(root = document) {
    let last = null;
    try {
      root.querySelectorAll?.(`[${MARK_ATTR}="1"]`)?.forEach((el) => {
        if (!controlMatchesSubmitList(el)) {
          clearMark(el);
          return;
        }
        if (isVisible(el)) last = el;
      });
    } catch {
      // ignore
    }
    return last;
  }

  function pickPrimarySubmit(root = document) {
    const raw = collectRawCandidates(root);
    if (raw.length) return raw[raw.length - 1];
    return findExistingMarked(root);
  }

  /** Every visible control whose label matches SUBMIT_BUTTON_TEXTS. */
  function findSubmitControls(root = document) {
    const raw = collectRawCandidates(root);
    if (raw.length) return raw;
    const marked = findExistingMarked(root);
    return marked ? [marked] : [];
  }

  /**
   * Resolve the clicked control using the same list as detection.
   * Evaluated at event time so React re-renders / lost marks still work.
   */
  function resolveSubmitControlFromEvent(fromEvent) {
    if (!fromEvent) return null;
    const path =
      typeof fromEvent.composedPath === "function"
        ? fromEvent.composedPath()
        : [];
    for (const n of path) {
      if (n instanceof HTMLElement && isRawSubmitCandidate(n)) return n;
    }
    const t =
      fromEvent.target instanceof Element ? fromEvent.target : null;
    const closest = t?.closest?.(
      "button, input[type='submit'], input[type='button'], a[role='button'], [role='button']"
    );
    if (closest instanceof HTMLElement && isRawSubmitCandidate(closest)) {
      return closest;
    }
    return null;
  }

  /**
   * @param {Document} doc
   * @param {{ mark?: boolean }} opts mark=false → detect only (status UI after release)
   */
  function detectApplyPageSignals(doc = document, opts = {}) {
    const mark = opts.mark !== false;
    const all = collectRawCandidates(doc);
    const primary = all.length
      ? all[all.length - 1]
      : findExistingMarked(doc);

    if (mark) {
      const keep = new Set(all);
      try {
        doc.querySelectorAll?.(`[${MARK_ATTR}="1"]`)?.forEach((el) => {
          if (!keep.has(el)) clearMark(el);
        });
      } catch {
        // ignore
      }
      // Mark every list match — any of them must trigger capture on click.
      for (const el of all) markPrimarySubmit(el);
    }

    return {
      isApplyPage: all.length > 0 || Boolean(primary),
      submitCount: all.length || (primary ? 1 : 0),
      hasEmail: false,
      hasResumeUpload: false,
    };
  }

  function isMarkedCaptureSubmit(el) {
    if (!el) return false;
    return el.getAttribute?.(MARK_ATTR) === "1";
  }

  /**
   * Capture-hook gate: same criteria as detection (live list), mark optional.
   * Mark alone is never enough — text must still match SUBMIT_BUTTON_TEXTS.
   */
  function isSubmitCandidate(el) {
    return isRawSubmitCandidate(el);
  }

  global.Devora21DetectApply = {
    SUBMIT_BUTTON_TEXTS,
    DEFAULT_SUBMIT_BUTTON_TEXTS,
    getSubmitButtonTexts,
    setSubmitButtonTexts,
    detectApplyPageSignals,
    findSubmitControls,
    pickPrimarySubmit,
    resolveSubmitControlFromEvent,
    applyCaptureLabel,
    markPrimarySubmit,
    restoreOriginalLabel,
    clearMark,
    isSubmitCandidate,
    isRawSubmitCandidate,
    isMarkedCaptureSubmit,
    isSubmitLabel,
    controlMatchesSubmitList,
    MARK_ATTR,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
