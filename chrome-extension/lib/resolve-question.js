/**
 * Resolve the human-visible "question" for a form control across messy ATS HTML.
 * Priority follows what sighted users / screen readers see, not a single CSS layout.
 */
(function (global) {
  const FIELD_CONTAINER_SEL = [
    "[data-qa*='field' i]",
    "[data-testid*='field' i]",
    "[data-automation-id*='field' i]",
    "[class*='FormField']",
    "[class*='form-field']",
    "[class*='formField']",
    "[class*='field-wrapper']",
    "[class*='FieldWrapper']",
    "[class*='question']",
    "[class*='Question']",
    "[class*='application-question']",
    "fieldset",
    "[role='group']",
    "li",
    "tr",
    ".field",
    "div[class*='field' i]",
    "div[class*='Field']",
    "section",
  ].join(",");

  const LABELISH_SEL =
    "label, legend, [class*='label' i], [class*='Label'], [class*='question' i], [class*='Question'], [class*='title' i], [class*='Title'], h1, h2, h3, h4, h5, h6, p, span, div";

  function cleanText(raw, max = 400) {
    let t = String(raw || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\*\s*$/g, "")
      .replace(/^\*\s*/, "")
      .trim();
    // Workable-style: aria-labelledby joins question+option → "YES YES"
    t = dedupeRepeatedPhrase(t);
    return t.slice(0, max);
  }

  /** "YES YES" / "foo bar foo bar" → single copy */
  function dedupeRepeatedPhrase(t) {
    const parts = String(t || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length < 2) return String(t || "").trim();
    if (
      parts.length === 2 &&
      parts[0].toLowerCase() === parts[1].toLowerCase()
    ) {
      return parts[0];
    }
    if (parts.length % 2 === 0) {
      const half = parts.length / 2;
      const a = parts.slice(0, half).join(" ");
      const b = parts.slice(half).join(" ");
      if (a.toLowerCase() === b.toLowerCase()) return a;
    }
    return String(t || "").trim();
  }

  function textsFromLabelledByIds(el, ids, { optionOnly = false, questionOnly = false } = {}) {
    if (!el?.ownerDocument || !ids?.length) return "";
    const parts = [];
    for (const id of ids) {
      if (!id) continue;
      const isOptionId = /^radio_label_/i.test(id) || /_option/i.test(id);
      if (questionOnly && isOptionId) continue;
      if (optionOnly && !isOptionId) continue;
      try {
        const n = el.ownerDocument.getElementById(id);
        const tx = n ? textOf(n) : "";
        if (tx) parts.push(tx);
      } catch {
        // ignore
      }
    }
    return cleanText(parts.join(" "));
  }

  /** Prefer short question-like strings; reject huge blobs / pure option lists. */
  function isGoodQuestion(text) {
    const t = cleanText(text);
    if (!t) return false;
    if (t.length < 2 || t.length > 350) return false;
    // Too many newlines → grabbed a whole form section
    if ((text.match(/\n/g) || []).length > 4) return false;
    return true;
  }

  function textOf(node) {
    if (!node) return "";
    try {
      return cleanText(node.innerText || node.textContent || "");
    } catch {
      return "";
    }
  }

  function resolveAriaLabelledBy(el, opts) {
    const ids = (el.getAttribute?.("aria-labelledby") || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return textsFromLabelledByIds(el, ids, opts);
  }

  function findRadioGroup(el) {
    if (!el) return null;
    const group =
      el.closest?.("[role='radiogroup'], fieldset[role='radiogroup'], fieldset") ||
      null;
    if (group) return group;
    const name = el.name;
    if (!name || !el.ownerDocument) return null;
    // Synthetic group: first radiogroup ancestor of any same-name radio
    try {
      const peer = el.ownerDocument.querySelector(
        `input[type="radio"][name="${CSS.escape(name)}"]`
      );
      return (
        peer?.closest?.("[role='radiogroup'], fieldset") || null
      );
    } catch {
      return null;
    }
  }

  function radiosInGroup(group, name) {
    if (!group) return [];
    try {
      if (name) {
        return Array.from(
          group.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)
        );
      }
      return Array.from(group.querySelectorAll('input[type="radio"]'));
    } catch {
      return [];
    }
  }

  function checkedRadioInGroup(el) {
    const type = (el?.type || "").toLowerCase();
    if (type !== "radio") return el;
    if (el.checked) return el;
    const group = findRadioGroup(el);
    const list = radiosInGroup(group, el.name);
    const checked = list.find((r) => r.checked);
    if (checked) return checked;
    // Same name anywhere in document
    if (el.name && el.ownerDocument) {
      try {
        const all = el.ownerDocument.querySelectorAll(
          `input[type="radio"][name="${CSS.escape(el.name)}"]`
        );
        return Array.from(all).find((r) => r.checked) || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Visible YES/NO (etc.) for one radio option — not the group question. */
  function radioOptionLabel(input) {
    if (!input) return "";
    const id = input.id;
    if (id && input.ownerDocument) {
      const byId =
        input.ownerDocument.getElementById(`radio_label_${id}`) ||
        input.ownerDocument.getElementById(`label_${id}`);
      if (byId) {
        const t = textOf(byId);
        if (t) return dedupeRepeatedPhrase(t);
      }
    }
    const wrapper = input.closest?.("[role='radio'], [data-ui='option']");
    if (wrapper) {
      // aria-labelledby often = "questionId radio_label_xxx" → take option ids only
      const opt = resolveAriaLabelledBy(wrapper, { optionOnly: true });
      if (opt) return dedupeRepeatedPhrase(opt);
      const span = wrapper.querySelector?.(
        "[id^='radio_label_'], [class*='illustrated'], span"
      );
      if (span && !span.querySelector?.("input")) {
        const t = textOf(span);
        // Avoid grabbing the whole question if span is huge
        if (t && t.length <= 40) return dedupeRepeatedPhrase(t);
      }
    }
    const fromLabel = htmlLabels(input);
    if (fromLabel && fromLabel.length <= 40) {
      return dedupeRepeatedPhrase(fromLabel);
    }
    // Map value true/false → YES/NO only if no visible text
    const v = String(input.value || "").toLowerCase();
    if (v === "true") return "YES";
    if (v === "false") return "NO";
    return cleanText(input.value || "");
  }

  /** Group question only (Workable: radiogroup aria-labelledby → question span). */
  function radioGroupQuestion(input) {
    const group = findRadioGroup(input);
    if (group) {
      const qOnly = resolveAriaLabelledBy(group, { questionOnly: true });
      if (qOnly && isGoodQuestion(qOnly)) return qOnly;
      const all = resolveAriaLabelledBy(group);
      if (all && isGoodQuestion(all)) return all;
      if (group.getAttribute?.("aria-label")) {
        const v = cleanText(group.getAttribute("aria-label"));
        if (isGoodQuestion(v)) return v;
      }
      const leg = group.querySelector?.(":scope > legend");
      if (leg) {
        const v = textOf(leg);
        if (isGoodQuestion(v)) return v;
      }
    }
    // Input-group wrapper: span[id$=_label] before the fieldset
    const pack = input.closest?.(
      "[class*='input-group'], [class*='FormField'], [class*='field']"
    );
    if (pack) {
      const lab = pack.querySelector?.(
        "[id$='_label'], [class*='label'] strong, legend, [class*='question']"
      );
      if (lab && !lab.closest?.("[role='radio']")) {
        const v = textOf(lab);
        if (isGoodQuestion(v)) return v;
      }
    }
    const g = groupAccessibleName(input) || fieldsetLegend(input);
    if (g && isGoodQuestion(g)) return g;
    return "";
  }

  function resolveAriaDescribedBy(el) {
    const ids = (el.getAttribute?.("aria-describedby") || "").trim();
    if (!ids || !el.ownerDocument) return "";
    return cleanText(
      ids
        .split(/\s+/)
        .map((id) => {
          try {
            const n = el.ownerDocument.getElementById(id);
            return n ? textOf(n) : "";
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join(" ")
    );
  }

  function htmlLabels(el) {
    const parts = [];
    try {
      if (el.labels?.length) {
        for (const l of el.labels) parts.push(textOf(l));
      }
    } catch {
      // ignore
    }
    if (el.id && el.ownerDocument) {
      try {
        const byFor = el.ownerDocument.querySelector(
          `label[for="${CSS.escape(el.id)}"]`
        );
        if (byFor) parts.push(textOf(byFor));
      } catch {
        // ignore
      }
    }
    const wrap = el.closest?.("label");
    if (wrap) {
      // For checkbox inside label, strip the control's own value noise by cloning
      parts.push(labelTextExcludingControl(wrap, el));
    }
    return cleanText(parts.filter(Boolean).join(" "));
  }

  function labelTextExcludingControl(labelEl, control) {
    try {
      const clone = labelEl.cloneNode(true);
      const kill = clone.querySelectorAll("input, select, textarea, button");
      kill.forEach((n) => n.remove());
      return cleanText(clone.innerText || clone.textContent || "");
    } catch {
      return textOf(labelEl);
    }
  }

  function fieldsetLegend(el) {
    const fs = el.closest?.("fieldset");
    if (!fs) return "";
    const leg = fs.querySelector(":scope > legend");
    return leg ? textOf(leg) : "";
  }

  function groupAccessibleName(el) {
    const group = el.closest?.("[role='group'], [role='radiogroup'], fieldset");
    if (!group) return "";
    if (group.getAttribute?.("aria-label")) {
      return cleanText(group.getAttribute("aria-label"));
    }
    const by = resolveAriaLabelledBy(group);
    if (by) return by;
    if (group.tagName === "FIELDSET") {
      const leg = group.querySelector(":scope > legend");
      if (leg) return textOf(leg);
    }
    return "";
  }

  /**
   * Walk up a few parents; in each field-like container, take the first
   * labelish node that appears *before* the control in document order.
   */
  function questionFromFieldContainer(el) {
    let node = el.parentElement;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      if (!node.matches?.(FIELD_CONTAINER_SEL) && depth > 0) {
        // Still try common wrappers even if selector missed.
        const cls = String(node.className || "");
        if (
          depth > 2 &&
          !/field|question|form|input|control|row|item/i.test(cls) &&
          node.tagName !== "LI" &&
          node.tagName !== "TR"
        ) {
          continue;
        }
      }

      // Explicit question nodes inside container
      const explicit = node.querySelector(
        "[class*='question' i], [data-qa*='question' i], [data-testid*='question' i], legend"
      );
      if (explicit && !explicit.contains(el)) {
        const t = textOf(explicit);
        if (isGoodQuestion(t)) return t;
      }

      const candidates = node.querySelectorAll(LABELISH_SEL);
      for (const c of candidates) {
        if (c === el || c.contains(el)) continue;
        if (el.contains(c)) continue;
        // Must be before the control (typical: label above / left of input)
        const pos = el.compareDocumentPosition(c);
        const cBefore =
          (pos & Node.DOCUMENT_POSITION_PRECEDING) !== 0 &&
          (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) === 0;
        if (!cBefore) continue;
        const t = textOf(c);
        if (!isGoodQuestion(t)) continue;
        // Skip tiny chrome ("*", "Required")
        if (/^(\*|•|·|-|required|optional)$/i.test(t)) continue;
        return t;
      }

      // Direct previous siblings of the control's offsetParent chain
      let sib = el.previousElementSibling;
      let hops = 0;
      while (sib && hops < 4) {
        const t = textOf(sib);
        if (isGoodQuestion(t) && t.length < 200) return t;
        sib = sib.previousElementSibling;
        hops++;
      }
    }
    return "";
  }

  function humanizeName(raw) {
    return cleanText(
      String(raw || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_\-.[\]0-9]+/g, " ")
        .replace(/\b(input|field|question|answer)\b/gi, " ")
    );
  }

  /**
   * @returns {{ question: string, optionLabel: string, strategy: string }}
   */
  function resolveQuestion(el) {
    if (!el) return { question: "", optionLabel: "", strategy: "none" };

    const type = (el.type || "").toLowerCase();

    // Radios: never use per-option aria-labelledby (includes question+YES).
    if (type === "radio") {
      const q = radioGroupQuestion(el);
      const optionLabel = radioOptionLabel(el);
      return {
        question: q,
        optionLabel,
        strategy: q ? "radiogroup" : "radiogroup-fallback",
      };
    }

    const optionLabel = (() => {
      if (type !== "checkbox") return "";
      const fromLabel = htmlLabels(el);
      if (fromLabel && fromLabel.length <= 80) return dedupeRepeatedPhrase(fromLabel);
      const next = el.nextElementSibling;
      if (next) {
        const t = textOf(next);
        if (t && t.length < 120) return dedupeRepeatedPhrase(t);
      }
      return cleanText(el.value || "");
    })();

    const tryOrder = [
      () => {
        const v = cleanText(el.getAttribute?.("aria-label"));
        return v && isGoodQuestion(v) ? { question: v, strategy: "aria-label" } : null;
      },
      () => {
        const v = resolveAriaLabelledBy(el, { questionOnly: true }) ||
          resolveAriaLabelledBy(el);
        return v && isGoodQuestion(v)
          ? { question: v, strategy: "aria-labelledby" }
          : null;
      },
      () => {
        const g = groupAccessibleName(el) || fieldsetLegend(el);
        if (g && isGoodQuestion(g)) {
          return { question: g, strategy: "group-legend" };
        }
        return null;
      },
      () => {
        if (type === "checkbox") return null;
        const v = htmlLabels(el);
        return v && isGoodQuestion(v) ? { question: v, strategy: "label" } : null;
      },
      () => {
        const v = questionFromFieldContainer(el);
        return v ? { question: v, strategy: "field-container" } : null;
      },
      () => {
        const v = resolveAriaDescribedBy(el);
        return v && isGoodQuestion(v) && v.length < 200
          ? { question: v, strategy: "aria-describedby" }
          : null;
      },
      () => {
        const v = cleanText(el.getAttribute?.("placeholder"));
        return v && isGoodQuestion(v) ? { question: v, strategy: "placeholder" } : null;
      },
      () => {
        const v = cleanText(el.getAttribute?.("title"));
        return v && isGoodQuestion(v) ? { question: v, strategy: "title" } : null;
      },
      () => {
        const v = humanizeName(el.name || el.id || "");
        return v && v.length > 2
          ? { question: v, strategy: "name" }
          : null;
      },
    ];

    for (const fn of tryOrder) {
      try {
        const hit = fn();
        if (hit?.question) {
          return { ...hit, optionLabel };
        }
      } catch {
        // continue
      }
    }

    return { question: "", optionLabel, strategy: "none" };
  }

  /**
   * Build Q + A for a control.
   * Radios → ONE question (group) + selected option as answer (never "Q — YES" rows).
   */
  function resolveQaPair(el) {
    const type = (el.type || el.tagName || "").toLowerCase();

    // Always resolve against the checked radio in the group.
    if (type === "radio") {
      const selected = checkedRadioInGroup(el);
      if (!selected) {
        return {
          question: radioGroupQuestion(el),
          answer: "",
          strategy: "radiogroup-none-selected",
          optionLabel: "",
          skip: true,
        };
      }
      const question = radioGroupQuestion(selected);
      const optionLabel = radioOptionLabel(selected);
      return {
        question:
          question ||
          humanizeName(selected.name || "") ||
          "Untitled question",
        answer: optionLabel || selected.value || "true",
        strategy: "radiogroup",
        optionLabel,
        skip: false,
      };
    }

    const { question, optionLabel, strategy } = resolveQuestion(el);

    let answer = "";
    if (el.isContentEditable) {
      answer = cleanText(el.innerText || el.textContent || "");
    } else if (type === "checkbox") {
      // Standalone / multi checkbox: keep option in question only if no group title
      if (el.checked) {
        answer = optionLabel || el.value || "true";
      } else {
        answer = "";
      }
    } else if (el.tagName === "SELECT") {
      answer = cleanText(
        el.options[el.selectedIndex]?.text || el.value || ""
      );
    } else {
      answer = el.value || "";
    }

    let q = question;
    if (type === "checkbox") {
      // Prefer group question alone; put option text in answer when checked
      if (!q && optionLabel) q = optionLabel;
      else if (
        q &&
        optionLabel &&
        q.toLowerCase() !== optionLabel.toLowerCase() &&
        optionLabel.length <= 40
      ) {
        // answer already option; do not duplicate into question
      }
    }

    return {
      question: q,
      answer,
      strategy,
      optionLabel,
      skip: false,
    };
  }

  global.Devora21ResolveQuestion = {
    resolveQuestion,
    resolveQaPair,
    cleanText,
    findRadioGroup,
    checkedRadioInGroup,
    radioOptionLabel,
    radioGroupQuestion,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
