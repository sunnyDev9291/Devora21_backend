import { getSettings, getTabState, hostAllowed } from "./lib/storage.js";
import { fetchMe } from "./lib/api.js";

const els = {
  statusLine: document.getElementById("statusLine"),
  ownerEmail: document.getElementById("ownerEmail"),
  tabHost: document.getElementById("tabHost"),
  applyPage: document.getElementById("applyPage"),
  applySignals: document.getElementById("applySignals"),
  hostAllowed: document.getElementById("hostAllowed"),
  pairCount: document.getElementById("pairCount"),
  btnToggle: document.getElementById("btnToggle"),
  btnPause: document.getElementById("btnPause"),
  btnResume: document.getElementById("btnResume"),
  btnClear: document.getElementById("btnClear"),
  btnRefresh: document.getElementById("btnRefresh"),
  btnClearHl: document.getElementById("btnClearHl"),
  btnZoomIn: document.getElementById("btnZoomIn"),
  btnZoomOut: document.getElementById("btnZoomOut"),
  btnFitView: document.getElementById("btnFitView"),
  btnViewDom: document.getElementById("btnViewDom"),
  btnViewBfs: document.getElementById("btnViewBfs"),
  zoomLabel: document.getElementById("zoomLabel"),
  openOptions: document.getElementById("openOptions"),
  error: document.getElementById("error"),
  inspectorMeta: document.getElementById("inspectorMeta"),
  domTree: document.getElementById("domTree"),
  nodeDetail: document.getElementById("nodeDetail"),
  nodeDetailBody: document.getElementById("nodeDetailBody"),
  aiContextDetail: document.getElementById("aiContextDetail"),
  aiContextBody: document.getElementById("aiContextBody"),
};

let lastDomContextAi = null;

let refreshBusy = false;
let currentInspection = null;
let selectedNodeId = null;
/** @type {"dom" | "bfs"} */
let treeMode = "dom";
/** Per-mode camera so switching views keeps each mode's zoom/pan. */
const viewStateByMode = { dom: null, bfs: null };
/** @type {null | { scale: number, tx: number, ty: number, contentW: number, contentH: number, treeKey: string }} */
let viewState = null;
let panSession = null;
let resizeObserver = null;
/** Stable selection identity across DOM/BFS trees (nodeId differs). */
let selectedCssSelector = null;

function activeTreeRoot(inspection = currentInspection) {
  if (!inspection) return null;
  if (treeMode === "bfs" && inspection.bfsRoot) return inspection.bfsRoot;
  return inspection.root || null;
}

function syncViewToggleUi() {
  els.btnViewDom?.classList.toggle("is-active", treeMode === "dom");
  els.btnViewBfs?.classList.toggle("is-active", treeMode === "bfs");
  els.btnViewDom?.setAttribute("aria-selected", treeMode === "dom" ? "true" : "false");
  els.btnViewBfs?.setAttribute("aria-selected", treeMode === "bfs" ? "true" : "false");
}

function showError(msg) {
  if (!msg) {
    els.error.hidden = true;
    els.error.textContent = "";
    return;
  }
  els.error.hidden = false;
  els.error.textContent = msg;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function forceScan(tabId, tabUrl) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["lib/detect-apply.js"],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const api = globalThis.Devora21DetectApply;
        if (!api) return null;
        return api.detectApplyPageSignals(document);
      },
    });

    let hasEmail = false;
    let hasResumeUpload = false;
    for (const r of results || []) {
      if (!r?.result) continue;
      if (r.result.hasEmail) hasEmail = true;
      if (r.result.hasResumeUpload) hasResumeUpload = true;
    }

    await chrome.runtime.sendMessage({
      type: "APPLY_PAGE_DETECTED",
      tabId,
      url: tabUrl || "",
      pageTitle: "",
      hasEmail,
      hasResumeUpload,
    });

    try {
      await chrome.tabs.sendMessage(tabId, { type: "FORCE_APPLY_SCAN" });
    } catch {
      // ok
    }
  } catch {
    // Restricted page
  }
}

function findNode(root, nodeId) {
  if (!root || nodeId == null) return null;
  if (root.nodeId === nodeId) return root;
  for (const c of root.children || []) {
    const hit = findNode(c, nodeId);
    if (hit) return hit;
  }
  return null;
}

function findNodeBySelector(root, cssSelector) {
  if (!root || !cssSelector) return null;
  if (root.cssSelector === cssSelector) return root;
  for (const c of root.children || []) {
    const hit = findNodeBySelector(c, cssSelector);
    if (hit) return hit;
  }
  return null;
}

function resolveSelectedNode(inspection = currentInspection) {
  const root = activeTreeRoot(inspection);
  if (!root) return null;
  if (selectedNodeId) {
    const byId = findNode(root, selectedNodeId);
    if (byId) return byId;
  }
  if (selectedCssSelector) {
    return findNodeBySelector(root, selectedCssSelector);
  }
  return null;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Color: selected > trigger > text-match (bfs) > ordinary blue */
function nodeColorClass(node) {
  if (node.nodeId === selectedNodeId) return "selected";
  if (node.kind === "trigger") return "trigger";
  if (node.kind === "bfs") return "text";
  return "blue";
}

function nodeShortLabel(node, depth) {
  if (node.kind === "trigger") return "T";
  if (node.kind === "bfs" && node.bfsIndex != null) return `M${node.bfsIndex}`;
  if (depth === 0 && node.visitOrder == null) return "root";
  return node.tagName || "?";
}

function nodeTitle(node) {
  const tag = node.tagName || "?";
  const id = node.idAttr ? `#${node.idAttr}` : "";
  const text = String(node.textPreview || "").replace(/\s+/g, " ").trim();
  const ord =
    node.visitOrder != null ? `bfs#${node.visitOrder}` : "unvisited-path";
  const match =
    node.kind === "bfs" && node.bfsIndex != null
      ? ` · text-match ${node.bfsIndex}`
      : node.kind === "trigger"
        ? " · trigger"
        : "";
  return `${ord}${match} <${tag}${id}> ${text}`.trim();
}

function treeKeyOf(inspection, mode = treeMode) {
  return `${mode}:${inspection?.capturedAt || 0}:${inspection?.elementKey || ""}:${inspection?.bfsCount || 0}:${inspection?.visitedCount || 0}`;
}

const NODE_FILL = {
  blue: { fill: "#3b82f6", stroke: "#1d4ed8" },
  text: { fill: "#22c55e", stroke: "#15803d" },
  trigger: { fill: "#eab308", stroke: "#a16207" },
  selected: { fill: "#ef4444", stroke: "#b91c1c" },
};

const VIEW_PAD = 16;
const MIN_SCALE = 0.15;
const MAX_SCALE = 4;

function updateZoomLabel() {
  if (!els.zoomLabel) return;
  const pct = viewState ? Math.round(viewState.scale * 100) : 100;
  els.zoomLabel.textContent = `${pct}%`;
}

function applyViewTransform() {
  const g = els.domTree.querySelector?.(".tviewport");
  if (!g || !viewState) return;
  g.setAttribute(
    "transform",
    `translate(${viewState.tx},${viewState.ty}) scale(${viewState.scale})`
  );
  viewStateByMode[treeMode] = viewState;
  updateZoomLabel();
}

function fitViewToContainer() {
  if (!viewState) return;
  const box = els.domTree.getBoundingClientRect();
  const vw = Math.max(box.width, 40);
  const vh = Math.max(box.height, 40);
  const cw = viewState.contentW;
  const ch = viewState.contentH;
  if (cw <= 0 || ch <= 0) return;
  const sx = (vw - VIEW_PAD * 2) / cw;
  const sy = (vh - VIEW_PAD * 2) / ch;
  const scale = Math.min(sx, sy, 1.25);
  viewState.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
  viewState.tx = (vw - cw * viewState.scale) / 2;
  viewState.ty = (vh - ch * viewState.scale) / 2;
  applyViewTransform();
}

function zoomAt(clientX, clientY, factor) {
  if (!viewState) return;
  const box = els.domTree.getBoundingClientRect();
  const mx = clientX - box.left;
  const my = clientY - box.top;
  const prev = viewState.scale;
  const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, prev * factor));
  if (next === prev) return;
  // Keep world point under cursor stable.
  const wx = (mx - viewState.tx) / prev;
  const wy = (my - viewState.ty) / prev;
  viewState.scale = next;
  viewState.tx = mx - wx * next;
  viewState.ty = my - wy * next;
  applyViewTransform();
}

function paintNodeColors() {
  const root = activeTreeRoot();
  els.domTree.querySelectorAll?.(".tnode[data-node-id]").forEach((g) => {
    const id = g.getAttribute("data-node-id");
    const node = findNode(root, id);
    if (!node) return;
    const key = nodeColorClass(node);
    const colors = NODE_FILL[key] || NODE_FILL.blue;
    const dot = g.querySelector(".tdot");
    if (!dot) return;
    dot.setAttribute("class", `tdot ${key}`);
    dot.setAttribute("fill", colors.fill);
    dot.setAttribute("stroke", colors.stroke);
  });
}

/**
 * Top-down tidy tree with fit-to-view + zoom/pan.
 * Selection only repaints colors (zoom/pan preserved).
 */
function renderNodeGraph(inspection, opts = {}) {
  const { preserveView = false, fit = false } = opts;
  const treeRoot = activeTreeRoot(inspection);

  if (!treeRoot) {
    viewState = null;
    viewStateByMode.dom = null;
    viewStateByMode.bfs = null;
    els.domTree.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Interact with the form to build a node tree.";
    els.domTree.appendChild(empty);
    updateZoomLabel();
    return;
  }

  const key = treeKeyOf(inspection, treeMode);
  const saved = viewStateByMode[treeMode];
  const sameTree = preserveView && saved && saved.treeKey === key;
  if (sameTree && els.domTree.querySelector(".ttree") && viewState?.treeKey === key) {
    paintNodeColors();
    return;
  }

  const H_GAP = 44;
  const V_GAP = 48;
  const PAD_X = 20;
  const PAD_Y = 18;
  const R = 7;
  const positions = new Map();

  let leafX = 0;
  function layout(node, depth) {
    const kids = node.children || [];
    if (!kids.length) {
      const entry = { node, x: leafX++, y: depth, depth };
      positions.set(node.nodeId, entry);
      return entry;
    }
    const childEntries = kids.map((c) => layout(c, depth + 1));
    const x =
      (childEntries[0].x + childEntries[childEntries.length - 1].x) / 2;
    const entry = { node, x, y: depth, depth };
    positions.set(node.nodeId, entry);
    return entry;
  }

  layout(treeRoot, 0);

  const all = [...positions.values()];
  const maxX = Math.max(0, ...all.map((p) => p.x));
  const maxY = Math.max(0, ...all.map((p) => p.y));
  const contentW = PAD_X * 2 + (maxX + 1) * H_GAP;
  const contentH = PAD_Y * 2 + (maxY + 1) * V_GAP + 12;

  const px = (p) => PAD_X + p.x * H_GAP;
  const py = (p) => PAD_Y + p.y * V_GAP;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("class", "ttree");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("role", "img");
  svg.setAttribute(
    "aria-label",
    treeMode === "bfs" ? "BFS discovery tree" : "DOM hierarchy tree"
  );

  const gView = document.createElementNS(svgNS, "g");
  gView.setAttribute("class", "tviewport");

  const gEdges = document.createElementNS(svgNS, "g");
  gEdges.setAttribute("class", "tedges");
  const gNodes = document.createElementNS(svgNS, "g");
  gNodes.setAttribute("class", "tnodes");

  function addPath(d) {
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("class", "tedge");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "#cbd5e1");
    path.setAttribute("stroke-width", "1.25");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    gEdges.appendChild(path);
  }

  for (const p of all) {
    const kids = p.node.children || [];
    if (!kids.length) continue;
    const childPos = kids.map((c) => positions.get(c.nodeId)).filter(Boolean);
    if (!childPos.length) continue;

    const x1 = px(p);
    const y1 = py(p) + R;
    const midY = (y1 + py(childPos[0]) - R) / 2;
    addPath(`M${x1} ${y1} V${midY}`);

    if (childPos.length === 1) {
      addPath(`M${x1} ${midY} V${py(childPos[0]) - R}`);
    } else {
      addPath(
        `M${px(childPos[0])} ${midY} H${px(childPos[childPos.length - 1])}`
      );
      for (const c of childPos) {
        addPath(`M${px(c)} ${midY} V${py(c) - R}`);
      }
    }
  }

  for (const p of all) {
    const { node, depth } = p;
    const cx = px(p);
    const cy = py(p);
    const colorKey = nodeColorClass(node);
    const colors = NODE_FILL[colorKey] || NODE_FILL.blue;
    const r = depth === 0 && node.kind === "trigger" ? R + 2 : R;
    const hasOrder = node.visitOrder != null && Number.isFinite(node.visitOrder);

    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", "tnode");
    g.setAttribute("data-node-id", node.nodeId);
    g.setAttribute("transform", `translate(${cx},${cy})`);

    const hit = document.createElementNS(svgNS, "circle");
    hit.setAttribute("r", "14");
    hit.setAttribute("fill", "transparent");
    g.appendChild(hit);

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("class", `tdot ${colorKey}`);
    dot.setAttribute("r", String(r));
    dot.setAttribute("fill", colors.fill);
    dot.setAttribute("stroke", colors.stroke);
    dot.setAttribute("stroke-width", node.kind === "trigger" ? "2.25" : "1.75");
    g.appendChild(dot);

    // BFS visitation order badge (trigger = 0, then 1, 2, …).
    if (hasOrder) {
      const bx = r + 6;
      const by = -r - 2;
      const badge = document.createElementNS(svgNS, "g");
      badge.setAttribute("class", "vbadge");
      badge.setAttribute("transform", `translate(${bx},${by})`);

      const bg = document.createElementNS(svgNS, "rect");
      const labelText = String(node.visitOrder);
      const bw = Math.max(12, 6 + labelText.length * 5);
      bg.setAttribute("x", String(-bw / 2));
      bg.setAttribute("y", "-7");
      bg.setAttribute("width", String(bw));
      bg.setAttribute("height", "12");
      bg.setAttribute("rx", "3");
      bg.setAttribute(
        "fill",
        node.kind === "trigger"
          ? "#a16207"
          : node.kind === "bfs"
            ? "#15803d"
            : "#334155"
      );
      badge.appendChild(bg);

      const bt = document.createElementNS(svgNS, "text");
      bt.setAttribute("text-anchor", "middle");
      bt.setAttribute("y", "2.5");
      bt.setAttribute("fill", "#fff");
      bt.setAttribute("font-size", "8");
      bt.setAttribute("font-weight", "700");
      bt.setAttribute("font-family", "ui-sans-serif, system-ui, sans-serif");
      bt.textContent = labelText;
      badge.appendChild(bt);
      g.appendChild(badge);
    }

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("class", "tlabel");
    label.setAttribute("y", String(r + 11));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", "#64748b");
    label.setAttribute("font-size", "9");
    label.setAttribute("font-weight", "600");
    label.textContent = nodeShortLabel(node, depth);
    g.appendChild(label);

    const title = document.createElementNS(svgNS, "title");
    title.textContent = nodeTitle(node);
    g.appendChild(title);

    gNodes.appendChild(g);
  }

  gView.appendChild(gEdges);
  gView.appendChild(gNodes);
  svg.appendChild(gView);

  els.domTree.replaceChildren();
  els.domTree.appendChild(svg);

  const prev =
    saved && saved.treeKey === key
      ? saved
      : null;
  viewState = {
    scale: prev?.scale ?? 1,
    tx: prev?.tx ?? 0,
    ty: prev?.ty ?? 0,
    contentW,
    contentH,
    treeKey: key,
  };
  viewStateByMode[treeMode] = viewState;

  // Fit on new capture or explicit mode switch; otherwise restore saved camera.
  requestAnimationFrame(() => {
    if (!prev || fit) fitViewToContainer();
    else applyViewTransform();
  });
}

async function fetchLiveInfo(cssSelector) {
  const tab = await activeTab();
  if (tab?.id == null || !cssSelector) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, {
      type: "GET_ELEMENT_INFO",
      cssSelector,
    });
  } catch {
    return null;
  }
}

async function showNodeDetail(node) {
  if (!node) {
    els.nodeDetail.hidden = true;
    els.nodeDetailBody.textContent = "";
    return;
  }
  els.nodeDetail.hidden = false;
  els.nodeDetailBody.textContent = "Loading…";

  const live = await fetchLiveInfo(node.cssSelector);
  els.nodeDetailBody.textContent =
    live?.outerHTML || node.outerHTML || "—";
}

function renderAiContext(ctx) {
  lastDomContextAi = ctx || null;
  if (!els.aiContextDetail || !els.aiContextBody) return;
  if (!ctx) {
    els.aiContextDetail.hidden = true;
    els.aiContextBody.textContent = "";
    return;
  }
  els.aiContextDetail.hidden = false;
  els.aiContextBody.textContent = JSON.stringify(ctx, null, 2);
}

async function highlightOnPage(node) {
  const tab = await activeTab();
  if (tab?.id == null || !node?.cssSelector) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "HIGHLIGHT_DOM_NODE",
      cssSelector: node.cssSelector,
      scroll: true,
    });
  } catch {
    // content script missing
  }
}

async function clearPageHighlight() {
  const tab = await activeTab();
  if (tab?.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_HIGHLIGHTS" });
  } catch {
    // ignore
  }
}

function renderInspection(inspection) {
  const prevKey = currentInspection
    ? treeKeyOf(currentInspection, "dom")
    : "";
  currentInspection = inspection || null;
  const nextKey = inspection ? treeKeyOf(inspection, "dom") : "";
  const isNewTree = !inspection?.root || prevKey !== nextKey;
  if (isNewTree) {
    selectedNodeId = null;
    selectedCssSelector = null;
    viewStateByMode.dom = null;
    viewStateByMode.bfs = null;
  }

  if (!inspection?.root) {
    els.inspectorMeta.textContent = "Waiting for a user action…";
    renderNodeGraph(null);
    els.nodeDetail.hidden = true;
    return;
  }

  const when = inspection.capturedAt
    ? new Date(inspection.capturedAt).toLocaleTimeString()
    : "—";
  els.inspectorMeta.textContent = [
    `${treeMode === "bfs" ? "BFS" : "DOM"} view`,
    `${inspection.actionType || "action"} · ${inspection.componentType || "control"}`,
    `“${String(inspection.value || "").slice(0, 36)}”`,
    `text ${inspection.bfsCount ?? 0}/5`,
    `visited ${inspection.visitedCount ?? "—"}`,
    when,
  ].join(" · ");

  renderNodeGraph(inspection, {
    preserveView: !isNewTree,
    fit: isNewTree,
  });
  if (isNewTree) els.nodeDetail.hidden = true;
}

function setTreeMode(mode) {
  if (mode !== "dom" && mode !== "bfs") return;
  if (mode === treeMode) return;

  // Remember selection by CSS selector across mode-specific nodeIds.
  const prev = resolveSelectedNode();
  if (prev?.cssSelector) selectedCssSelector = prev.cssSelector;

  if (viewState) viewStateByMode[treeMode] = viewState;
  treeMode = mode;
  syncViewToggleUi();

  if (!currentInspection?.root) return;

  const when = currentInspection.capturedAt
    ? new Date(currentInspection.capturedAt).toLocaleTimeString()
    : "—";
  els.inspectorMeta.textContent = [
    `${treeMode === "bfs" ? "BFS" : "DOM"} view`,
    `${currentInspection.actionType || "action"} · ${currentInspection.componentType || "control"}`,
    `“${String(currentInspection.value || "").slice(0, 36)}”`,
    `text ${currentInspection.bfsCount ?? 0}/5`,
    `visited ${currentInspection.visitedCount ?? "—"}`,
    when,
  ].join(" · ");

  const saved = viewStateByMode[treeMode];
  const key = treeKeyOf(currentInspection, treeMode);
  renderNodeGraph(currentInspection, {
    preserveView: Boolean(saved && saved.treeKey === key),
    fit: !(saved && saved.treeKey === key),
  });

  const match = resolveSelectedNode();
  if (match) {
    selectedNodeId = match.nodeId;
    selectedCssSelector = match.cssSelector || selectedCssSelector;
    paintNodeColors();
    void showNodeDetail(match);
    void highlightOnPage(match);
  }
}

function bindTreeInteractions() {
  const host = els.domTree;

  host.addEventListener(
    "wheel",
    (e) => {
      if (!viewState || !host.querySelector(".ttree")) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(e.clientX, e.clientY, factor);
    },
    { passive: false }
  );

  host.addEventListener("pointerdown", (e) => {
    if (!viewState || !host.querySelector(".ttree")) return;
    if (e.button !== 0) return;
    // Don't start pan on a node — allow click select.
    if (e.target.closest?.("[data-node-id]")) return;
    host.setPointerCapture?.(e.pointerId);
    panSession = {
      startX: e.clientX,
      startY: e.clientY,
      origTx: viewState.tx,
      origTy: viewState.ty,
      moved: false,
      pointerId: e.pointerId,
    };
    host.classList.add("is-panning");
  });

  host.addEventListener("pointermove", (e) => {
    if (!panSession || !viewState) return;
    const dx = e.clientX - panSession.startX;
    const dy = e.clientY - panSession.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) panSession.moved = true;
    viewState.tx = panSession.origTx + dx;
    viewState.ty = panSession.origTy + dy;
    applyViewTransform();
  });

  const endPan = (e) => {
    if (!panSession) return;
    if (e?.pointerId != null) {
      try {
        host.releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore
      }
    }
    host.classList.remove("is-panning");
    // Keep moved flag briefly so click handler can ignore a drag-end click.
    const moved = panSession.moved;
    panSession = null;
    if (moved) host.dataset.suppressClick = "1";
  };
  host.addEventListener("pointerup", endPan);
  host.addEventListener("pointercancel", endPan);

  host.addEventListener("click", (e) => {
    if (host.dataset.suppressClick === "1") {
      delete host.dataset.suppressClick;
      return;
    }
    const g = e.target.closest?.("[data-node-id]");
    if (!g) return;
    e.preventDefault();
    e.stopPropagation();
    const id = g.getAttribute("data-node-id");
    selectedNodeId = id;
    const node = findNode(activeTreeRoot(), id);
    selectedCssSelector = node?.cssSelector || null;
    renderNodeGraph(currentInspection, { preserveView: true });
    void showNodeDetail(node);
    void highlightOnPage(node);
  });

  if (!resizeObserver && typeof ResizeObserver !== "undefined") {
    let resizeTimer = null;
    resizeObserver = new ResizeObserver(() => {
      if (!viewState || !currentInspection?.root) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => fitViewToContainer(), 80);
    });
    resizeObserver.observe(host);
  }
}

async function loadInspectionForActiveTab() {
  const tab = await activeTab();
  if (tab?.id == null) {
    renderInspection(null);
    renderAiContext(null);
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: "GET_LAST_INSPECTION",
      tabId: tab.id,
    });
    if (res?.inspection) {
      renderInspection(res.inspection);
    } else {
      const state = await getTabState(tab.id);
      renderInspection(state.lastInspection || null);
      renderAiContext(res?.domContextAi || state.lastDomContextAi || null);
      return;
    }
    renderAiContext(res?.domContextAi || null);
  } catch {
    renderInspection(null);
    renderAiContext(null);
  }
}

async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    showError("");
    const settings = await getSettings();
    const tab = await activeTab();
    const tabId = tab?.id;
    const url = tab?.url || "";
    let host = "—";
    try {
      host = new URL(url).hostname;
    } catch {
      host = url || "—";
    }

    await forceScan(tabId, url);

    const restrictList = settings.allowedHosts || [];
    const allowed = hostAllowed(url, restrictList);
    const state =
      tabId != null
        ? await getTabState(tabId)
        : {
            pairs: {},
            paused: false,
            isApplyPage: false,
            hasEmail: false,
            hasResumeUpload: false,
          };
    const count = Object.keys(state.pairs || {}).length;
    const isApplyPage = Boolean(state.isApplyPage);

    els.tabHost.textContent = host;
    els.applyPage.textContent = isApplyPage
      ? "yes · syncing to backend"
      : count > 0
        ? "no · buffering locally"
        : "no · waiting";
    els.applySignals.textContent = `email:${state.hasEmail ? "✓" : "–"} resume:${
      state.hasResumeUpload ? "✓" : "–"
    }`;
    els.hostAllowed.textContent =
      restrictList.length === 0
        ? "all sites"
        : allowed
          ? "allowed"
          : "blocked by list";
    els.pairCount.textContent = String(count);

    const canWork =
      settings.recordingEnabled &&
      settings.consentAccepted &&
      allowed &&
      !state.paused;

    els.statusLine.className = "status";
    if (!settings.consentAccepted) {
      els.statusLine.textContent = "Consent required — open Options";
      els.statusLine.classList.add("off");
    } else if (!settings.recordingEnabled) {
      els.statusLine.textContent = "Recording off";
      els.statusLine.classList.add("off");
    } else if (!allowed) {
      els.statusLine.textContent = "This host is outside your restrict list";
      els.statusLine.classList.add("off");
    } else if (state.paused) {
      els.statusLine.textContent = "Paused on this tab";
      els.statusLine.classList.add("paused");
    } else if (isApplyPage && canWork) {
      els.statusLine.textContent = "Apply Page · syncing buffer to backend";
      els.statusLine.classList.add("on");
    } else if (canWork) {
      els.statusLine.textContent =
        count > 0
          ? `Buffering ${count} field(s) · waiting for email + resume`
          : "Buffering on · waiting for Apply Page (email + resume)";
      els.statusLine.classList.add("paused");
    }

    els.btnToggle.textContent = settings.recordingEnabled
      ? "Disable recording"
      : "Enable recording";

    try {
      if (settings.apiKey) {
        const me = await fetchMe();
        els.ownerEmail.textContent = me?.user?.email || me?.user?.id || "—";
      } else {
        els.ownerEmail.textContent = "API key missing";
      }
    } catch (err) {
      els.ownerEmail.textContent = "Auth failed";
      showError(err.message || String(err));
    }

    if (!currentInspection && state.lastInspection) {
      renderInspection(state.lastInspection);
    }
  } finally {
    refreshBusy = false;
  }
}

async function sendAction(action) {
  const tab = await activeTab();
  await chrome.runtime.sendMessage({
    type: "POPUP_ACTION",
    action,
    tabId: tab?.id,
  });
  await refresh();
  if (action === "clear_tab") {
    renderInspection(null);
    renderAiContext(null);
    void clearPageHighlight();
  }
}

els.btnToggle.addEventListener("click", () => sendAction("toggle_recording"));
els.btnPause.addEventListener("click", () => sendAction("pause"));
els.btnResume.addEventListener("click", () => sendAction("resume"));
els.btnClear.addEventListener("click", () => sendAction("clear_tab"));
els.btnRefresh.addEventListener("click", () => refresh());
els.btnClearHl?.addEventListener("click", () => {
  selectedNodeId = null;
  selectedCssSelector = null;
  if (currentInspection) {
    renderNodeGraph(currentInspection, { preserveView: true });
  }
  els.nodeDetail.hidden = true;
  void clearPageHighlight();
});
els.btnZoomIn?.addEventListener("click", () => {
  const box = els.domTree.getBoundingClientRect();
  zoomAt(box.left + box.width / 2, box.top + box.height / 2, 1.2);
});
els.btnZoomOut?.addEventListener("click", () => {
  const box = els.domTree.getBoundingClientRect();
  zoomAt(box.left + box.width / 2, box.top + box.height / 2, 1 / 1.2);
});
els.btnFitView?.addEventListener("click", () => fitViewToContainer());
els.btnViewDom?.addEventListener("click", () => setTreeMode("dom"));
els.btnViewBfs?.addEventListener("click", () => setTreeMode("bfs"));
els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

syncViewToggleUi();
bindTreeInteractions();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "INSPECTION_UPDATED") {
    void (async () => {
      const tab = await activeTab();
      if (tab?.id != null && message.tabId != null && tab.id !== message.tabId) {
        return;
      }
      if (message.domContextAi) {
        renderAiContext(message.domContextAi);
      }
      if (!message.inspection) return;
      const prevSel =
        selectedCssSelector ||
        resolveSelectedNode()?.cssSelector ||
        null;
      renderInspection(message.inspection);
      if (prevSel) {
        selectedCssSelector = prevSel;
        const match = findNodeBySelector(activeTreeRoot(message.inspection), prevSel);
        if (match) {
          selectedNodeId = match.nodeId;
          renderNodeGraph(message.inspection, { preserveView: true });
          void showNodeDetail(match);
          void highlightOnPage(match);
        }
      }
    })();
  }
});

chrome.tabs.onActivated.addListener(() => {
  void refresh();
  void loadInspectionForActiveTab();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    void refresh();
    void loadInspectionForActiveTab();
  }
});
chrome.storage.onChanged.addListener(() => {
  void refresh();
});

void refresh();
void loadInspectionForActiveTab();
setInterval(() => {
  void refresh();
}, 2500);
