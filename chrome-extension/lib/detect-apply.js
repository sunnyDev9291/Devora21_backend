/**
 * Detect job-application pages: must see BOTH an email input and a resume upload.
 * Scans light DOM + open shadow roots + same-origin iframes.
 * Cross-origin iframes are covered by content_scripts all_frames + background aggregation.
 */
(function (global) {
  function textBlob(el) {
    if (!el) return "";
    return [
      el.name,
      el.id,
      el.className && String(el.className),
      el.getAttribute?.("placeholder"),
      el.getAttribute?.("aria-label"),
      el.getAttribute?.("aria-labelledby"),
      el.getAttribute?.("data-testid"),
      el.getAttribute?.("data-qa"),
      el.getAttribute?.("data-automation-id"),
      el.getAttribute?.("data-field"),
      el.getAttribute?.("data-name"),
      el.getAttribute?.("accept"),
      el.getAttribute?.("autocomplete"),
      el.getAttribute?.("inputmode"),
      el.getAttribute?.("title"),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function resolveAriaLabelledBy(el) {
    const ids = (el.getAttribute?.("aria-labelledby") || "").trim();
    if (!ids || !el.ownerDocument) return "";
    return ids
      .split(/\s+/)
      .map((id) => {
        try {
          const node = el.ownerDocument.getElementById(id);
          return (node?.innerText || node?.textContent || "").trim();
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join(" ");
  }

  function labelText(el) {
    try {
      if (el.getAttribute?.("aria-label")) return el.getAttribute("aria-label");
      const aria = resolveAriaLabelledBy(el);
      if (aria) return aria;
      if (el.labels?.length) {
        return Array.from(el.labels)
          .map((l) => l.innerText || l.textContent || "")
          .join(" ");
      }
      if (el.id) {
        const lab = el.ownerDocument?.querySelector?.(
          `label[for="${CSS.escape(el.id)}"]`
        );
        if (lab) return lab.innerText || lab.textContent || "";
      }
      const wrap = el.closest?.("label");
      if (wrap) return wrap.innerText || wrap.textContent || "";
    } catch {
      // ignore
    }
    return "";
  }

  function nearbyText(el, max = 600) {
    try {
      const root =
        el.closest?.(
          "label,fieldset,section,li,td,tr,div[class*='field'],div[class*='Field'],div[class*='form'],div[class*='upload'],div[class*='Upload'],div[class*='drop'],form"
        ) || el.parentElement;
      const t = (root?.innerText || root?.textContent || "").trim();
      return t.slice(0, max).toLowerCase();
    } catch {
      return "";
    }
  }

  /**
   * Collect inputs from document + nested open shadow roots + same-origin iframes.
   */
  function collectInputs(root, out = [], depth = 0) {
    if (!root || depth > 8) return out;
    try {
      const nodes = root.querySelectorAll?.("input") || [];
      for (const el of nodes) out.push(el);

      const all = root.querySelectorAll?.("*") || [];
      for (const el of all) {
        if (el.shadowRoot) collectInputs(el.shadowRoot, out, depth + 1);
      }

      // Same-origin child frames (cross-origin throws; those rely on all_frames).
      const frames = root.querySelectorAll?.("iframe, frame") || [];
      for (const frame of frames) {
        try {
          const childDoc =
            frame.contentDocument || frame.contentWindow?.document;
          if (childDoc) collectInputs(childDoc, out, depth + 1);
        } catch {
          // cross-origin
        }
      }
    } catch {
      // cross-origin or closed shadow — skip
    }
    return out;
  }

  function looksLikeEmailText(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return (
      /\be-?mails?\b/.test(t) ||
      /emailaddress|email_address|user_email|applicant.?email|work.?email|contact.?email|confirm.?email|your.?email|login.?email/.test(
        t
      ) ||
      /(^|[^a-z])email([^a-z]|$)/.test(t)
    );
  }

  function isEmailInput(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const type = (el.type || "text").toLowerCase();
    if (type === "email") return true;
    if (
      type === "hidden" ||
      type === "password" ||
      type === "file" ||
      type === "checkbox" ||
      type === "radio" ||
      type === "submit" ||
      type === "button" ||
      type === "image" ||
      type === "reset" ||
      type === "color" ||
      type === "range" ||
      type === "date" ||
      type === "datetime-local" ||
      type === "time" ||
      type === "month" ||
      type === "week" ||
      type === "number"
    ) {
      return false;
    }
    const auto = (
      el.autocomplete ||
      el.getAttribute("autocomplete") ||
      ""
    ).toLowerCase();
    if (auto.includes("email")) return true;
    if ((el.getAttribute("inputmode") || "").toLowerCase() === "email") {
      return true;
    }

    const blob = `${textBlob(el)} ${labelText(el)} ${nearbyText(el)}`;
    return looksLikeEmailText(blob);
  }

  function isImageOnlyAccept(accept) {
    const a = String(accept || "").toLowerCase().trim();
    if (!a) return false;
    // image/* only (no pdf/doc) → profile photo, not resume
    if (/pdf|\.doc|msword|officedocument|rtf|text\/plain/.test(a)) {
      return false;
    }
    return (
      /^(image\/|\.png|\.jpe?g|\.gif|\.webp|\.bmp|\.svg)/.test(a) ||
      /^image\//.test(a)
    );
  }

  function looksLikeResumeOrDocUpload(text) {
    const t = String(text || "").toLowerCase();
    if (!t) return false;
    return /resume|curriculum|\bcv\b|cover.?letter|upload.*(resume|cv|file|document)|(resume|cv).*upload|attach.*(resume|cv|file|document)|drop.*(resume|cv|file|document)|choose.*(file|document)|select.*(file|document)|browse.*(file|document)|drag.?and.?drop|drop.?zone|pdf|docx?|\.pdf/.test(
      t
    );
  }

  function isResumeUpload(el) {
    if (!el || el.tagName !== "INPUT") return false;
    if ((el.type || "").toLowerCase() !== "file") return false;

    const accept = (el.accept || "").toLowerCase();
    if (isImageOnlyAccept(accept)) return false;

    if (
      /pdf|msword|officedocument|document|\.doc|\.docx|\.pdf|\.rtf|\.txt|application\/pdf|text\/plain|\*\/\*/.test(
        accept
      )
    ) {
      return true;
    }

    const blob = `${textBlob(el)} ${labelText(el)} ${nearbyText(el)}`;
    if (looksLikeResumeOrDocUpload(blob)) return true;

    // Generic file input on an apply form (no accept, vague name) — still count
    // when nearby copy mentions upload/file/document OR name/id looks like attachment.
    if (!accept || accept === "*") {
      if (
        /file|upload|attach|document|resume|cv|application/i.test(
          `${el.name || ""} ${el.id || ""} ${el.className || ""}`
        )
      ) {
        return true;
      }
      if (/\b(upload|attach|file|document)\b/.test(blob)) return true;
    }

    return false;
  }

  /**
   * @returns {{ isApplyPage: boolean, hasEmail: boolean, hasResumeUpload: boolean, inputCount: number }}
   */
  function detectApplyPageSignals(doc = document) {
    const inputs = collectInputs(doc);
    let hasEmail = false;
    let hasResumeUpload = false;
    for (const el of inputs) {
      if (!hasEmail && isEmailInput(el)) hasEmail = true;
      if (!hasResumeUpload && isResumeUpload(el)) hasResumeUpload = true;
      if (hasEmail && hasResumeUpload) break;
    }

    // Fallback: any non-image file input + email on same document tree.
    if (hasEmail && !hasResumeUpload) {
      for (const el of inputs) {
        if (el.tagName !== "INPUT") continue;
        if ((el.type || "").toLowerCase() !== "file") continue;
        if (isImageOnlyAccept(el.accept || "")) continue;
        hasResumeUpload = true;
        break;
      }
    }

    return {
      isApplyPage: hasEmail && hasResumeUpload,
      hasEmail,
      hasResumeUpload,
      inputCount: inputs.length,
    };
  }

  global.Devora21DetectApply = {
    detectApplyPageSignals,
    isEmailInput,
    isResumeUpload,
    collectInputs,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
