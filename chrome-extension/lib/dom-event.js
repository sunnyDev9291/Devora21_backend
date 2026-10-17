/**
 * Event payloads + BFS DOM context for DeepSeek question matching.
 * Extension discovers nearby text-bearing nodes; DeepSeek does semantic match.
 */
(function (global) {
  const BFS_TEXT_TARGET = 5;
  const BFS_MAX_NODES = 400;
  const OUTER_HTML_CAP = 12_000;
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "SVG",
    "PATH",
    "META",
    "LINK",
    "HEAD",
    "BR",
    "HR",
  ]);

  const ATTR_ALLOW = [
    "id",
    "name",
    "type",
    "role",
    "aria-label",
    "aria-labelledby",
    "aria-checked",
    "aria-pressed",
    "aria-required",
    "placeholder",
    "autocomplete",
    "data-option",
    "data-field-path",
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
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(">");
  }

  function ashbyFieldPath(el) {
    const field = el?.closest?.("[data-field-path], [data-field-entry-id]");
    if (!field) return "";
    return (
      field.getAttribute("data-field-path") ||
      field.getAttribute("data-field-entry-id") ||
      ""
    );
  }

  function elementKey(el) {
    if (!el) return "";
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    const path = ashbyFieldPath(el);

    if (path && (type === "radio" || type === "checkbox" || role === "radio" || role === "checkbox" || role === "switch")) {
      return `ashby:${path}`;
    }
    if (path && el.closest?.(".ashby-application-form-input-yesno, [class*='yesno']")) {
      return `ashby:${path}`;
    }
    if (type === "radio" && el.name) return `radio[name=${el.name}]`;
    if (el.id) return `${tag}#${el.id}`;
    if (el.name) return `${tag}[name=${el.name}]${type ? `[type=${type}]` : ""}`;
    const sel = cssSelector(el);
    return sel || `${tag}:${type || role || "unknown"}`;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
      if (!style) return true;
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect?.();
      if (rect && rect.width === 0 && rect.height === 0) return false;
      return true;
    } catch {
      return true;
    }
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

  /** Text from direct child text nodes only (not inherited from descendants). */
  function directText(el) {
    if (!el?.childNodes) return "";
    let s = "";
    try {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) s += n.textContent || "";
      }
    } catch {
      return "";
    }
    return s.replace(/\s+/g, " ").trim();
  }

  /**
   * Qualifying text element for the BFS match limit:
   * - meaningful direct text (or leaf textContent), not whitespace-only
   * - prefer leaves (no element children)
   * - non-leaves only if they have their own direct text
   */
  function isQualifyingTextElement(el, trigger) {
    if (!el || el === trigger || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (!isVisible(el)) return false;

    const isLeaf = !el.children || el.children.length === 0;
    const own = directText(el);

    if (isLeaf) {
      const t = own || visibleText(el);
      return t.length >= 2 && t.length <= 2000;
    }
    // Non-leaf: only count if it has meaningful direct text of its own.
    return own.length >= 2 && own.length <= 2000;
  }

  /** Block ancestor↔descendant pairs from both counting as text matches. */
  function isAncestorOrDescendantOfSelected(el, selected) {
    for (const s of selected) {
      if (!s?.el) continue;
      if (el === s.el) return true;
      if (el.contains(s.el) || s.el.contains(el)) return true;
    }
    return false;
  }

  function textPreviewForMatch(el) {
    const own = directText(el);
    if (own) return own.slice(0, 240);
    return visibleText(el).slice(0, 240);
  }

  function capOuterHtml(el) {
    try {
      return String(el?.outerHTML || "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .trim()
        .slice(0, OUTER_HTML_CAP);
    } catch {
      return "";
    }
  }

  /**
   * BFS from trigger (single-pass, sync).
   * - `visited` = nodes actually dequeued/processed (shown in the inspector).
   * - `textHits` = qualifying text matches only; hard-capped at `limit` (default 5).
   * - On the Nth match: stop immediately — clear the queue, do not expand neighbors,
   *   do not process remaining frontier nodes.
   */
  function bfsNearbyTextElementsRaw(trigger, limit = BFS_TEXT_TARGET) {
    const empty = {
      textHits: [],
      visited: [],
      visitOrder: new Map(),
      discoveredFrom: new Map(),
      discoveredVia: new Map(),
    };
    if (!trigger || trigger.nodeType !== 1) return empty;
    const cap = Math.max(0, Math.floor(Number(limit) || BFS_TEXT_TARGET));

    const queue = [{ el: trigger, dist: 0, via: "self", from: null }];
    const seen = new Set([trigger]);
    const visited = [];
    /** @type {Map<Element, number>} BFS dequeue order — trigger is always 0. */
    const visitOrder = new Map();
    /** @type {Map<Element, Element>} first-discovery parent in the BFS tree */
    const discoveredFrom = new Map();
    /** @type {Map<Element, string>} via edge when first discovered */
    const discoveredVia = new Map();
    const selected = [];
    let scanned = 0;
    let done = false;

    while (queue.length && !done && scanned < BFS_MAX_NODES) {
      const { el, dist, via } = queue.shift();
      if (!el) continue;
      scanned += 1;
      // Visitation order = sequential dequeue index (trigger first → 0).
      visitOrder.set(el, visited.length);
      visited.push(el);

      if (
        dist > 0 &&
        selected.length < cap &&
        isQualifyingTextElement(el, trigger) &&
        !isAncestorOrDescendantOfSelected(el, selected)
      ) {
        selected.push({
          el,
          distance: dist,
          relationship: via,
          visitOrder: visitOrder.get(el),
          tagName: (el.tagName || "").toLowerCase(),
          outerHTML: capOuterHtml(el),
          textPreview: textPreviewForMatch(el),
          cssSelector: cssSelector(el),
        });
        // Strict limit: stop at the Nth match — no further queue work.
        if (selected.length >= cap) {
          queue.length = 0;
          done = true;
          break;
        }
      }

      // Prefer children before parent/siblings (near leaf text first).
      const neighbors = [];
      for (const child of Array.from(el.children || []).slice(0, 40)) {
        neighbors.push({ el: child, via: "child" });
      }
      if (el.parentElement) {
        neighbors.push({ el: el.parentElement, via: "parent" });
      }
      const parent = el.parentElement;
      if (parent) {
        for (const sib of Array.from(parent.children || []).slice(0, 40)) {
          if (sib !== el) neighbors.push({ el: sib, via: "sibling" });
        }
      }

      for (const n of neighbors) {
        if (!n.el || seen.has(n.el)) continue;
        if (SKIP_TAGS.has(n.el.tagName)) continue;
        seen.add(n.el);
        // First discovery wins → BFS tree edge (no duplicates).
        discoveredFrom.set(n.el, el);
        discoveredVia.set(n.el, n.via);
        queue.push({ el: n.el, dist: dist + 1, via: n.via, from: el });
      }
    }

    return {
      textHits: selected.slice(0, cap),
      visited,
      visitOrder,
      discoveredFrom,
      discoveredVia,
    };
  }

  function bfsNearbyTextElements(trigger, limit = BFS_TEXT_TARGET) {
    return bfsNearbyTextElementsRaw(trigger, limit).textHits.map(
      ({ el: _el, ...meta }) => meta
    );
  }

  function lcaTwo(a, b) {
    const ancestors = new Set();
    let n = a;
    while (n) {
      ancestors.add(n);
      n = n.parentElement;
    }
    n = b;
    while (n) {
      if (ancestors.has(n)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function lowestCommonAncestor(nodes) {
    const list = (nodes || []).filter(Boolean);
    if (!list.length) return null;
    let acc = list[0];
    for (let i = 1; i < list.length; i++) {
      acc = lcaTwo(acc, list[i]);
      if (!acc) return list[0].ownerDocument?.body || list[0];
    }
    return acc;
  }

  function isPageRoot(el) {
    return (
      !el ||
      el === document.body ||
      el === document.documentElement ||
      (el.id === "root" && el.tagName === "DIV")
    );
  }

  /**
   * Root for the inspector: LCA of visited nodes, capped to form/section
   * so the tree stays coherent (not <body>).
   */
  function inspectionRoot(trigger, visited, textHitEls) {
    const section = trigger.closest?.(
      ".ashby-application-form-section-container, [class*='section-container']"
    );
    const formBox = trigger.closest?.(
      ".ashby-application-form-container, #form, form"
    );
    const field = trigger.closest?.(
      "[data-field-path], .ashby-application-form-field-entry, fieldset, .ashby-application-form-input-yesno"
    );

    const scope = formBox || section || document.body;
    const inScope = (visited || []).filter(
      (v) => v && (v === scope || scope.contains?.(v))
    );
    const hitEls = (textHitEls || []).filter(
      (v) => v && (v === scope || scope.contains?.(v))
    );

    const lca =
      lowestCommonAncestor([trigger, ...inScope]) ||
      lowestCommonAncestor([trigger, ...hitEls]) ||
      trigger;

    const containsHits = (c) =>
      c &&
      hitEls.every((t) => t === c || (c.contains && c.contains(t))) &&
      (trigger === c || c.contains(trigger));

    // Prefer the tightest container that still holds trigger + text hits.
    for (const c of [field, section, lca, formBox]) {
      if (!c || isPageRoot(c)) continue;
      if (hitEls.length ? containsHits(c) : c === trigger || c.contains(trigger)) {
        return c;
      }
    }
    if (!isPageRoot(lca)) return lca;
    return field || section || trigger.parentElement || trigger;
  }

  function nodeOwnText(el, kind, meta) {
    if (kind === "trigger") {
      return String(meta.value || el.value || "").slice(0, 80);
    }
    const own = directText(el);
    if (own) return own.slice(0, 80);
    if (el.children?.length === 0) return visibleText(el).slice(0, 80);
    return "";
  }

  /**
   * Inspector trees from one BFS result:
   * - root: original DOM parent→child hierarchy
   * - bfsRoot: discovery tree rooted at trigger (visit #0)
   */
  function buildInspectionTree(trigger, bfsResult, meta = {}) {
    if (!trigger) return null;

    const hits = Array.isArray(bfsResult)
      ? bfsResult
      : bfsResult?.textHits || [];
    const visited = Array.isArray(bfsResult)
      ? hits.map((h) => h.el).filter(Boolean)
      : bfsResult?.visited || [];
    const visitOrder =
      !Array.isArray(bfsResult) && bfsResult?.visitOrder instanceof Map
        ? bfsResult.visitOrder
        : (() => {
            const m = new Map();
            visited.forEach((el, i) => m.set(el, i));
            return m;
          })();
    const discoveredFrom =
      !Array.isArray(bfsResult) && bfsResult?.discoveredFrom instanceof Map
        ? bfsResult.discoveredFrom
        : new Map();
    const discoveredVia =
      !Array.isArray(bfsResult) && bfsResult?.discoveredVia instanceof Map
        ? bfsResult.discoveredVia
        : new Map();

    if (trigger) visitOrder.set(trigger, 0);

    const hitEls = hits.map((h) => h.el).filter(Boolean);
    const domRootEl = inspectionRoot(trigger, visited, hitEls);

    const marked = new Map();
    marked.set(trigger, { kind: "trigger", visitOrder: 0 });
    hits.forEach((h, i) => {
      if (!h?.el || h.el === trigger) return;
      marked.set(h.el, {
        kind: "bfs",
        bfsIndex: i + 1,
        distance: h.distance,
        relationship: h.relationship,
        visitOrder: visitOrder.has(h.el) ? visitOrder.get(h.el) : h.visitOrder,
      });
    });

    function makeNode(el, depth, childEls, idPrefix) {
      const mark = marked.get(el);
      const kind = mark?.kind || "path";
      const order = visitOrder.has(el)
        ? visitOrder.get(el)
        : mark?.visitOrder != null
          ? mark.visitOrder
          : null;
      const via =
        mark?.relationship ||
        discoveredVia.get(el) ||
        (el === trigger ? "self" : undefined);

      return {
        nodeId: `${idPrefix}-${depth}-${order != null ? order : "p"}-${cssSelector(el).slice(0, 48)}`,
        depth,
        kind,
        visitOrder: order,
        bfsIndex: mark?.bfsIndex,
        distance: mark?.distance ?? (order != null ? order : undefined),
        relationship: via,
        tagName: (el.tagName || "").toLowerCase(),
        idAttr: el.id || "",
        className: shortClass(el),
        cssSelector: cssSelector(el),
        textPreview: nodeOwnText(el, kind, meta),
        outerHTML: capOuterHtml(el).slice(0, 8_000),
        attributes: collectAttributes(el),
        childCount: el.children?.length || 0,
        children: childEls.map((c) =>
          makeNode(
            c.el,
            depth + 1,
            c.children,
            idPrefix
          )
        ),
      };
    }

    // —— DOM view: real parent/child under a scoped container ——
    const keep = new Set();
    const addChain = (t) => {
      if (!t) return;
      if (!(t === domRootEl || domRootEl.contains(t))) return;
      let n = t;
      while (n) {
        keep.add(n);
        if (n === domRootEl) break;
        n = n.parentElement;
      }
    };
    addChain(trigger);
    for (const v of visited) addChain(v);

    function domChildrenOf(el) {
      return Array.from(el.children || [])
        .filter((c) => keep.has(c))
        .map((c) => ({ el: c, children: domChildrenOf(c) }));
    }

    const domRoot = makeNode(
      domRootEl,
      0,
      domChildrenOf(domRootEl),
      "dom"
    );

    // —— BFS view: discovery tree, trigger always root (#0) ——
    const visitedSet = new Set(visited);
    function bfsChildrenOf(el) {
      return visited
        .filter((v) => v !== el && discoveredFrom.get(v) === el && visitedSet.has(v))
        .sort(
          (a, b) => (visitOrder.get(a) ?? 0) - (visitOrder.get(b) ?? 0)
        )
        .map((c) => ({ el: c, children: bfsChildrenOf(c) }));
    }

    const bfsRoot = makeNode(
      trigger,
      0,
      bfsChildrenOf(trigger),
      "bfs"
    );

    return {
      version: 5,
      capturedAt: Date.now(),
      actionType: meta.actionType || "",
      componentType: meta.componentType || "",
      elementKey: meta.elementKey || elementKey(trigger),
      value: meta.value != null ? String(meta.value).slice(0, 500) : "",
      triggerSelector: cssSelector(trigger),
      bfsCount: Math.min(hits.length, BFS_TEXT_TARGET),
      visitedCount: visited.length,
      root: domRoot,
      bfsRoot,
    };
  }

  function collectAttributes(el) {
    const out = {};
    if (!el?.attributes) return out;
    for (const name of ATTR_ALLOW) {
      const v = el.getAttribute?.(name);
      if (v != null && String(v).trim() !== "") out[name] = String(v).slice(0, 500);
    }
    return out;
  }

  function optionLabel(input) {
    if (!input) return "";
    try {
      if (input.id) {
        const lab = document.querySelector(
          `label[for="${cssEscape(input.id)}"]`
        );
        if (lab) {
          return visibleText(lab).slice(0, 120);
        }
      }
    } catch {
      // ignore
    }
    const wrap = input.closest?.("label");
    if (wrap) {
      try {
        const clone = wrap.cloneNode(true);
        clone.querySelectorAll?.("input,select,textarea,button").forEach((n) =>
          n.remove()
        );
        const t = visibleText(clone).slice(0, 120);
        if (t) return t;
      } catch {
        // ignore
      }
    }
    if (input.getAttribute?.("data-option")) {
      const opt = input.getAttribute("data-option");
      if (opt === "yes") return "Yes";
      if (opt === "no") return "No";
      return opt;
    }
    return visibleText(input).slice(0, 120);
  }

  function readNativeRadioValue(el) {
    try {
      const name = el.name;
      if (!name) {
        return el.checked ? optionLabel(el) || el.value || "true" : "";
      }
      const root = el.form || document;
      const checked = Array.from(
        root.querySelectorAll(`input[type="radio"][name="${cssEscape(name)}"]`)
      ).find((n) => n.checked);
      if (!checked) return "";
      return optionLabel(checked) || checked.value || "true";
    } catch {
      return el.checked ? el.value || "true" : "";
    }
  }

  function readCheckboxGroupValue(el) {
    const field =
      el.closest?.("[data-field-path], fieldset, .ashby-application-form-field-entry") ||
      el.parentElement;
    const boxes = Array.from(
      field?.querySelectorAll?.('input[type="checkbox"]') || [el]
    ).filter((cb) => cb.tabIndex !== -1 && cb.getAttribute("tabindex") !== "-1");
    if (boxes.length <= 1) {
      return el.checked ? optionLabel(el) || el.name || el.value || "true" : "";
    }
    return boxes
      .filter((cb) => cb.checked)
      .map((cb) => optionLabel(cb) || cb.name || cb.value || "true")
      .join(", ");
  }

  function readAshbyYesNo(el) {
    const root = el.closest?.(
      ".ashby-application-form-input-yesno, [class*='yesno']"
    );
    if (!root) return null;
    if (el.getAttribute?.("data-option")) {
      const opt = el.getAttribute("data-option").toLowerCase();
      if (opt === "yes") return "Yes";
      if (opt === "no") return "No";
    }
    const pressed = root.querySelector?.("[aria-pressed='true']");
    if (pressed) return optionLabel(pressed) || visibleText(pressed).slice(0, 40);
    const darkSelected = Array.from(
      root.querySelectorAll?.("button[data-option]") || []
    ).find((b) => {
      try {
        const s = getComputedStyle(b);
        const m = (s.backgroundColor || "").match(
          /rgba?\((\d+),\s*(\d+),\s*(\d+)/i
        );
        if (!m) return false;
        const sum = Number(m[1]) + Number(m[2]) + Number(m[3]);
        return sum < 220;
      } catch {
        return false;
      }
    });
    if (darkSelected) return optionLabel(darkSelected);
    const cb = root.querySelector?.('input[type="checkbox"]');
    if (cb?.checked) return "Yes";
    return null;
  }

  function readValue(el) {
    if (!el) return "";
    if (el.isContentEditable) return visibleText(el);

    const yesNo = readAshbyYesNo(el);
    if (yesNo != null && yesNo !== "") return yesNo;

    const type = (el.type || "").toLowerCase();
    if (type === "checkbox") return readCheckboxGroupValue(el);
    if (type === "radio") return readNativeRadioValue(el);
    if (el.tagName === "SELECT") {
      const opts = Array.from(el.selectedOptions || []);
      if (opts.length > 1) {
        return opts.map((o) => o.text || o.value).join(", ");
      }
      return el.options[el.selectedIndex]?.text || el.value || "";
    }
    if (type === "file") {
      const files = Array.from(el.files || []);
      return files.map((f) => f.name).join(", ") || (el.value ? "file" : "");
    }
    if (el.getAttribute?.("role") === "slider" || type === "range") {
      return String(el.value ?? el.getAttribute?.("aria-valuenow") ?? "");
    }
    return el.value || visibleText(el) || "";
  }

  function componentTypeOf(el) {
    if (!el) return "unknown";
    const type = (el.type || "").toLowerCase();
    const role = String(el.getAttribute?.("role") || "").toLowerCase();
    const tag = (el.tagName || "").toLowerCase();
    if (type === "radio" || role === "radio") return "radio";
    if (type === "checkbox" || role === "checkbox" || role === "switch") {
      return "checkbox";
    }
    if (el.closest?.(".ashby-application-form-input-yesno, [class*='yesno']")) {
      return "yesno";
    }
    if (tag === "select" || role === "listbox" || role === "combobox") {
      return "dropdown";
    }
    if (type === "file") return "file";
    if (type === "range" || role === "slider") return "slider";
    if (tag === "textarea" || el.isContentEditable) return "textarea";
    if (tag === "button" || type === "submit" || type === "button" || role === "button") {
      return "button";
    }
    if (tag === "input") return type || "text";
    return tag || "unknown";
  }

  function isMirrorChoiceInput(el) {
    if (!el || el.tagName !== "INPUT") return false;
    const type = (el.type || "").toLowerCase();
    if (type !== "checkbox" && type !== "radio") return false;
    if (el.tabIndex === -1 || el.getAttribute?.("tabindex") === "-1") {
      if (
        el.closest?.(
          ".ashby-application-form-input-yesno, [class*='yesno']"
        ) ||
        el.parentElement?.querySelector?.("button[data-option]")
      ) {
        return true;
      }
    }
    return false;
  }

  function isTrackableControl(el) {
    if (!el || el.disabled || el.nodeType !== 1) return false;
    if (isMirrorChoiceInput(el)) return false;
    const tag = el.tagName;
    const type = (el.type || "").toLowerCase();
    const role = String(el.getAttribute?.("role") || "").toLowerCase();

    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag === "INPUT") {
      if (["button", "submit", "reset", "image", "hidden"].includes(type)) {
        return false;
      }
      return true;
    }
    if (el.isContentEditable) return true;
    if (role === "radio" || role === "checkbox" || role === "switch") return true;
    if (role === "slider" || role === "listbox" || role === "combobox") return true;
    if (
      tag === "BUTTON" &&
      (el.getAttribute("data-option") ||
        el.closest?.(".ashby-application-form-input-yesno, [class*='yesno']") ||
        role === "radio" ||
        role === "checkbox")
    ) {
      return true;
    }
    // Custom option chips (not nav/submit)
    if (
      (tag === "BUTTON" || role === "button") &&
      el.closest?.(
        "[data-field-path], .ashby-application-form-field-entry, [role='radiogroup'], fieldset"
      ) &&
      !/submit|apply|next|cancel|upload/i.test(visibleText(el))
    ) {
      const text = visibleText(el);
      if (text && text.length <= 80) return true;
    }
    return false;
  }

  function resolveControl(target) {
    if (!target) return null;
    const el =
      target instanceof HTMLElement
        ? target
        : target.parentElement instanceof HTMLElement
          ? target.parentElement
          : null;
    if (!el) return null;

    const optionRow = el.closest?.(
      ".ashby-application-form-input-radio-group-option, .ashby-application-form-input-checkbox-group-option, [class*='radio-group-option'], [class*='checkbox-group-option']"
    );
    if (optionRow) {
      const native = optionRow.querySelector?.(
        'input[type="radio"], input[type="checkbox"]'
      );
      if (native && isTrackableControl(native)) return native;
    }

    if (isTrackableControl(el)) return el;

    const nested = el.closest?.(
      "input, textarea, select, button[data-option], [contenteditable='true'], [role='radio'], [role='checkbox'], [role='switch']"
    );
    if (nested && isTrackableControl(nested)) return nested;

    const label = el.closest?.("label");
    if (label) {
      const input =
        label.querySelector?.("input, textarea, select") ||
        (label.htmlFor ? document.getElementById(label.htmlFor) : null);
      if (input && isTrackableControl(input)) return input;
    }

    // Yes/No / option buttons
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      if (isTrackableControl(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function buildDomContext(el, opts = {}) {
    if (!el) return null;
    const bfs = bfsNearbyTextElementsRaw(el, BFS_TEXT_TARGET);
    const nearby = bfs.textHits.map(({ el: _el, ...meta }) => meta);
    const inspection = buildInspectionTree(el, bfs, {
      actionType: opts.actionType,
      componentType: opts.componentType,
      elementKey: opts.elementKey,
      value: opts.value,
    });
    return {
      version: 3,
      strategy: "bfs",
      triggeredOuterHTML: capOuterHtml(el),
      nearbyElements: nearby,
      visitedCount: bfs.visited.length,
      inspection,
      pageTitle: document.title || "",
      element: {
        tagName: (el.tagName || "").toLowerCase(),
        inputType: (el.type || "").toLowerCase(),
        id: el.id || "",
        name: el.name || el.getAttribute?.("name") || "",
        cssSelector: cssSelector(el),
        componentType: componentTypeOf(el),
      },
    };
  }

  function buildDomInputEvent(el, eventType, opts = {}) {
    if (!el) return null;
    const tagName = (el.tagName || "").toLowerCase();
    const inputType = (el.type || tagName || "").toLowerCase();
    const componentType = componentTypeOf(el);
    const value = readValue(el);
    const key = elementKey(el);
    const includeContext = Boolean(opts.includeContext);
    const actionType = eventType || "input";

    const base = {
      elementKey: key,
      value,
      eventType: actionType,
      actionType,
      componentType,
      timestamp: Date.now(),
      tagName,
      inputType: componentType === "yesno" ? "radio" : inputType,
      elementId: el.id || "",
      name: el.name || el.getAttribute?.("name") || "",
      className: shortClass(el),
      cssSelector: cssSelector(el),
      attributes: collectAttributes(el),
      autocomplete: el.autocomplete || el.getAttribute?.("autocomplete") || "",
      label: `${tagName}${inputType && inputType !== tagName ? `[type=${inputType}]` : ""}${
        el.id ? `#${el.id}` : ""
      }${el.name ? `[name=${el.name}]` : ""}`,
      triggeredOuterHTML: includeContext ? capOuterHtml(el) : undefined,
    };

    if (includeContext) {
      base.domContext = buildDomContext(el, {
        actionType,
        componentType,
        elementKey: key,
        value,
      });
      base.inspection = base.domContext?.inspection || null;
    } else if (opts.includeInspection) {
      // Value-only updates still refresh the inspector around the control.
      const bfs = bfsNearbyTextElementsRaw(el, BFS_TEXT_TARGET);
      base.inspection = buildInspectionTree(el, bfs, {
        actionType,
        componentType,
        elementKey: key,
        value,
      });
    }
    if (opts.cachedQuestion) {
      base.cachedQuestion = opts.cachedQuestion;
      base.cachedConfidence = opts.cachedConfidence;
    }
    return base;
  }

  function listActiveChoiceControls(root = document) {
    const out = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el) || !isTrackableControl(el)) return;
      seen.add(el);
      out.push(el);
    };
    try {
      root
        .querySelectorAll?.(
          'input[type="radio"]:checked, input[type="checkbox"]:checked, [role="radio"][aria-checked="true"], [aria-pressed="true"]'
        )
        ?.forEach(add);
    } catch {
      // ignore
    }
    return out;
  }

  global.Devora21DomEvent = {
    buildDomInputEvent,
    buildDomContext,
    buildInspectionTree,
    bfsNearbyTextElements,
    isTrackableControl,
    resolveControl,
    elementKey,
    readValue,
    cssSelector,
    listActiveChoiceControls,
    componentTypeOf,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
