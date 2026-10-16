/**
 * Build DOM input-event payloads (no question↔answer matching).
 */
(function (global) {
  const ATTR_ALLOW = [
    "id",
    "name",
    "type",
    "role",
    "aria-label",
    "aria-labelledby",
    "aria-checked",
    "aria-required",
    "placeholder",
    "autocomplete",
    "inputmode",
    "data-ui",
    "data-testid",
    "data-qa",
    "value",
  ];

  function cssEscape(s) {
    try {
      return CSS.escape(s);
    } catch {
      return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }
  }

  function shortClass(el) {
    const raw = el.getAttribute?.("class") || el.className || "";
    const s = typeof raw === "string" ? raw : String(raw);
    return s.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  }

  /** Prefer stable, short selectors. */
  function cssSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return `${el.tagName.toLowerCase()}#${cssEscape(el.id)}`;
    const name = el.getAttribute?.("name");
    const type = (el.type || "").toLowerCase();
    if (name) {
      const tag = el.tagName.toLowerCase();
      const t = type ? `[type="${cssEscape(type)}"]` : "";
      return `${tag}${t}[name="${cssEscape(name)}"]`;
    }
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${cssEscape(node.id)}`);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === node.tagName
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(">");
  }

  function elementKey(el) {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    // Radio group: one key for the whole name so options upsert into one row.
    if (type === "radio" && el.name) return `radio[name=${el.name}]`;
    if (el.name) return `${tag}[name=${el.name}]${type ? `[type=${type}]` : ""}`;
    const sel = cssSelector(el);
    return sel || `${tag}:${type || "unknown"}`;
  }

  function readValue(el) {
    if (!el) return "";
    if (el.isContentEditable) {
      return String(el.innerText || el.textContent || "").trim();
    }
    const type = (el.type || "").toLowerCase();
    if (type === "checkbox") {
      return el.checked ? el.value || "true" : "";
    }
    if (type === "radio") {
      if (!el.checked) {
        // Prefer currently selected peer in the group.
        try {
          const form = el.form;
          const nodes = form
            ? form.querySelectorAll(
                `input[type="radio"][name="${CSS.escape(el.name)}"]`
              )
            : document.querySelectorAll(
                `input[type="radio"][name="${CSS.escape(el.name)}"]`
              );
          const checked = Array.from(nodes).find((n) => n.checked);
          if (!checked) return "";
          return optionVisibleText(checked) || checked.value || "true";
        } catch {
          return "";
        }
      }
      return optionVisibleText(el) || el.value || "true";
    }
    if (el.tagName === "SELECT") {
      return el.options[el.selectedIndex]?.text || el.value || "";
    }
    return el.value || "";
  }

  function optionVisibleText(input) {
    if (!input?.id) return "";
    try {
      const lab =
        document.getElementById(`radio_label_${input.id}`) ||
        document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lab) {
        return String(lab.innerText || lab.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
      }
    } catch {
      // ignore
    }
    const wrap = input.closest?.("[role='radio'], [data-ui='option']");
    if (wrap) {
      const span = wrap.querySelector?.("[id^='radio_label_'], span");
      if (span) {
        return String(span.innerText || span.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
      }
    }
    return "";
  }

  function collectAttributes(el) {
    const out = {};
    if (!el?.attributes) return out;
    for (const name of ATTR_ALLOW) {
      const v = el.getAttribute?.(name);
      if (v != null && String(v).trim() !== "") {
        out[name] = String(v).slice(0, 500);
      }
    }
    return out;
  }

  function buildDomInputEvent(el, eventType) {
    if (!el) return null;
    const tagName = (el.tagName || "").toLowerCase();
    const inputType = (el.type || tagName || "").toLowerCase();
    const value = readValue(el);
    const key = elementKey(el);
    const className = shortClass(el);
    const sel = cssSelector(el);
    return {
      elementKey: key,
      value,
      eventType: eventType || "input",
      timestamp: Date.now(),
      tagName,
      inputType,
      elementId: el.id || "",
      name: el.name || el.getAttribute?.("name") || "",
      className,
      cssSelector: sel,
      attributes: collectAttributes(el),
      autocomplete: el.autocomplete || el.getAttribute?.("autocomplete") || "",
      label: `${tagName}${inputType && inputType !== tagName ? `[type=${inputType}]` : ""}${
        el.id ? `#${el.id}` : ""
      }${el.name ? `[name=${el.name}]` : ""}`,
    };
  }

  function isTrackableControl(el) {
    if (!el || el.disabled) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "file", "image", "hidden"].includes(type)) {
        return false;
      }
      return true;
    }
    if (el.isContentEditable) return true;
    return false;
  }

  function resolveControl(target) {
    if (!(target instanceof HTMLElement)) return null;
    if (isTrackableControl(target)) return target;
    const roleRadio = target.closest?.("[role='radio'], [data-ui='option']");
    if (roleRadio) {
      const input = roleRadio.querySelector?.(
        'input[type="radio"], input[type="checkbox"]'
      );
      if (input && isTrackableControl(input)) return input;
    }
    const label = target.closest?.("label");
    if (label) {
      const input =
        label.querySelector?.(
          'input, textarea, select'
        ) ||
        (label.htmlFor ? document.getElementById(label.htmlFor) : null);
      if (input && isTrackableControl(input)) return input;
    }
    return null;
  }

  global.Devora21DomEvent = {
    buildDomInputEvent,
    isTrackableControl,
    resolveControl,
    elementKey,
    readValue,
    cssSelector,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
