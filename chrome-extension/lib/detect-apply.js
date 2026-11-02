/**
 * Application page detection:
 *   Email  — user types an email-shaped value into an input (action-based)
 *   Resume — user selects/uploads a PDF on input[type=file] (action-based)
 *   Submit — button / page include-match against SUBMIT_BUTTON_TEXTS allowlist
 *
 * All three Yes → application page; capture hooks use submit-list buttons.
 * Email/Resume Settings lists are unused for detection (action-only).
 */
(function (global) {
  const MARK_ATTR = "data-devora21-capture-submit";

  const DEFAULT_EMAIL_FIELD_TEXTS = ["Email", "E-mail"];
  const DEFAULT_RESUME_FIELD_TEXTS = ["Resume", "CV"];
  const DEFAULT_SUBMIT_BUTTON_TEXTS = ["Submit", "Apply", "Send"];

  const EMAIL_FIELD_TEXTS = DEFAULT_EMAIL_FIELD_TEXTS.slice();
  const RESUME_FIELD_TEXTS = DEFAULT_RESUME_FIELD_TEXTS.slice();
  const SUBMIT_BUTTON_TEXTS = DEFAULT_SUBMIT_BUTTON_TEXTS.slice();

  /** Sticky for this document until reset (navigation / explicit reset). */
  let emailDetectedByAction = false;
  let resumeDetectedByAction = false;
  let emailActionInput = null;
  let resumeActionInput = null;
  let actionListenersBound = false;
  let actionChangeCallback = null;

  function normalizeLabel(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeMatchKey(s) {
    return normalizeLabel(s).replace(/[^a-z0-9]+/g, "");
  }

  function sanitizeList(list, fallback) {
    const defaults =
      Array.isArray(fallback) && fallback.length
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

  function replaceList(target, cleaned) {
    target.length = 0;
    for (const t of cleaned) target.push(t);
    return target.slice();
  }

  function setEmailFieldTexts(list) {
    return replaceList(
      EMAIL_FIELD_TEXTS,
      sanitizeList(list, DEFAULT_EMAIL_FIELD_TEXTS)
    );
  }

  function setResumeFieldTexts(list) {
    return replaceList(
      RESUME_FIELD_TEXTS,
      sanitizeList(list, DEFAULT_RESUME_FIELD_TEXTS)
    );
  }

  function setSubmitButtonTexts(list) {
    return replaceList(
      SUBMIT_BUTTON_TEXTS,
      sanitizeList(list, DEFAULT_SUBMIT_BUTTON_TEXTS)
    );
  }

  function getEmailFieldTexts() {
    return EMAIL_FIELD_TEXTS.slice();
  }

  function getResumeFieldTexts() {
    return RESUME_FIELD_TEXTS.slice();
  }

  function getSubmitButtonTexts() {
    return SUBMIT_BUTTON_TEXTS.slice();
  }

  function setDetectionAllowLists({
    emailFieldTexts,
    resumeFieldTexts,
    submitButtonTexts,
  } = {}) {
    if (emailFieldTexts != null) setEmailFieldTexts(emailFieldTexts);
    if (resumeFieldTexts != null) setResumeFieldTexts(resumeFieldTexts);
    if (submitButtonTexts != null) setSubmitButtonTexts(submitButtonTexts);
    return {
      emailFieldTexts: getEmailFieldTexts(),
      resumeFieldTexts: getResumeFieldTexts(),
      submitButtonTexts: getSubmitButtonTexts(),
    };
  }

  function listIncludesMatch(haystack, list) {
    const n = normalizeMatchKey(haystack);
    if (!n) return false;
    return list
      .map(normalizeMatchKey)
      .filter(Boolean)
      .some((entry) => n.includes(entry));
  }

  function textMatchesSubmitList(raw) {
    return listIncludesMatch(raw, SUBMIT_BUTTON_TEXTS);
  }

  /** Email-shaped value the user typed (not just presence of an email input). */
  function looksLikeTypedEmail(value) {
    const s = String(value || "").trim();
    if (s.length < 6) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(s);
  }

  /** User uploaded a PDF (by MIME or .pdf filename). */
  function fileIsPdf(file) {
    if (!file) return false;
    const name = String(file.name || "").toLowerCase();
    const type = String(file.type || "").toLowerCase();
    return type === "application/pdf" || name.endsWith(".pdf");
  }

  function notifyActionChange() {
    try {
      actionChangeCallback?.();
    } catch {
      // ignore
    }
  }

  function onUserInputEvent(e) {
    const el = e?.target;
    if (!(el instanceof HTMLElement)) return;

    // —— Email: typing into a text-like control ——
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const type = String(el.type || "").toLowerCase();
      if (type === "file" || type === "password" || type === "hidden") {
        // fall through for file handling below
      } else if (type === "" || type === "text" || type === "email" || type === "search") {
        if (looksLikeTypedEmail(el.value)) {
          if (!emailDetectedByAction || emailActionInput !== el) {
            emailDetectedByAction = true;
            emailActionInput = el;
            notifyActionChange();
          }
        }
      }
    }

    // —— Resume: file input change / pick PDF ——
    if (el instanceof HTMLInputElement && String(el.type || "").toLowerCase() === "file") {
      const files = el.files;
      if (files && files.length) {
        let pdf = false;
        for (let i = 0; i < files.length; i++) {
          if (fileIsPdf(files[i])) {
            pdf = true;
            break;
          }
        }
        if (pdf) {
          if (!resumeDetectedByAction || resumeActionInput !== el) {
            resumeDetectedByAction = true;
            resumeActionInput = el;
            notifyActionChange();
          }
        }
      }
    }
  }

  /**
   * Bind document-level listeners (once). Call from content script boot.
   * onChange is invoked when email/resume action detection flips on.
   */
  function startActionDetection(onChange) {
    actionChangeCallback = typeof onChange === "function" ? onChange : null;
    if (actionListenersBound) return;
    actionListenersBound = true;
    // Capture phase so we see events before site handlers stop them.
    document.addEventListener("input", onUserInputEvent, true);
    document.addEventListener("change", onUserInputEvent, true);
  }

  function stopActionDetection() {
    if (!actionListenersBound) return;
    document.removeEventListener("input", onUserInputEvent, true);
    document.removeEventListener("change", onUserInputEvent, true);
    actionListenersBound = false;
    actionChangeCallback = null;
  }

  function resetActionDetection() {
    emailDetectedByAction = false;
    resumeDetectedByAction = false;
    emailActionInput = null;
    resumeActionInput = null;
  }

  function getActionDetectionState() {
    return {
      hasEmail: emailDetectedByAction,
      hasResumeUpload: resumeDetectedByAction,
      emailInput: emailActionInput,
      resumeInput: resumeActionInput,
    };
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

  function controlLabel(el) {
    const parts = controlLabelCandidates(el);
    return parts.length ? normalizeLabel(parts[0]) : "";
  }

  function isSubmitLabel(label) {
    return textMatchesSubmitList(label);
  }

  function controlMatchesSubmitList(el) {
    return controlLabelCandidates(el).some(textMatchesSubmitList);
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

  function findSubmitControls(root = document) {
    const raw = collectRawCandidates(root);
    if (raw.length) return raw;
    const marked = findExistingMarked(root);
    return marked ? [marked] : [];
  }

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

  function getPageContentText(root = document) {
    try {
      const doc = root.nodeType === 9 ? root : root.ownerDocument || document;
      const body = doc.body || doc.documentElement || root;
      if (!body) return "";
      return `${doc.title || ""}\n${body.textContent || ""}`;
    } catch {
      return "";
    }
  }

  function hasSubmitInPage(root = document) {
    if (collectRawCandidates(root).length > 0) return true;
    return listIncludesMatch(getPageContentText(root), SUBMIT_BUTTON_TEXTS);
  }

  function findEmailField() {
    return emailActionInput;
  }

  function findResumeField() {
    return resumeActionInput;
  }

  function hasEmailField() {
    return emailDetectedByAction;
  }

  function hasResumeField() {
    return resumeDetectedByAction;
  }

  function detectApplyPageSignals(doc = document, opts = {}) {
    const mark = opts.mark !== false;
    const hasEmail = emailDetectedByAction;
    const hasResumeUpload = resumeDetectedByAction;
    const all = collectRawCandidates(doc);
    const hasSubmit = all.length > 0 || hasSubmitInPage(doc);
    const isApplyPage = hasEmail && hasResumeUpload && hasSubmit;

    if (mark) {
      const keep = isApplyPage ? new Set(all) : new Set();
      try {
        doc.querySelectorAll?.(`[${MARK_ATTR}="1"]`)?.forEach((el) => {
          if (!keep.has(el)) clearMark(el);
        });
      } catch {
        // ignore
      }
      if (isApplyPage) {
        for (const el of all) markPrimarySubmit(el);
      }
    }

    return {
      isApplyPage,
      submitCount: all.length || (hasSubmit ? 1 : 0),
      hasEmail,
      hasResumeUpload,
      hasSubmit,
    };
  }

  function isApplicationFormPage(doc = document) {
    return detectApplyPageSignals(doc, { mark: false }).isApplyPage;
  }

  function isMarkedCaptureSubmit(el) {
    if (!el) return false;
    return el.getAttribute?.(MARK_ATTR) === "1";
  }

  function isSubmitCandidate(el) {
    return isRawSubmitCandidate(el);
  }

  global.Devora21DetectApply = {
    EMAIL_FIELD_TEXTS,
    RESUME_FIELD_TEXTS,
    SUBMIT_BUTTON_TEXTS,
    DEFAULT_EMAIL_FIELD_TEXTS,
    DEFAULT_RESUME_FIELD_TEXTS,
    DEFAULT_SUBMIT_BUTTON_TEXTS,
    getEmailFieldTexts,
    getResumeFieldTexts,
    getSubmitButtonTexts,
    setEmailFieldTexts,
    setResumeFieldTexts,
    setSubmitButtonTexts,
    setDetectionAllowLists,
    startActionDetection,
    stopActionDetection,
    resetActionDetection,
    getActionDetectionState,
    looksLikeTypedEmail,
    fileIsPdf,
    detectApplyPageSignals,
    isApplicationFormPage,
    findEmailField,
    findResumeField,
    hasEmailField,
    hasResumeField,
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
