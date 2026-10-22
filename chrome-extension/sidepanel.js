const els = {
  statusLine: document.getElementById("statusLine"),
  submitDetected: document.getElementById("submitDetected"),
  btnToggle: document.getElementById("btnToggle"),
  btnReloadList: document.getElementById("btnReloadList"),
  btnClearBuffer: document.getElementById("btnClearBuffer"),
  captureList: document.getElementById("captureList"),
  openOptions: document.getElementById("openOptions"),
  error: document.getElementById("error"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightboxImg"),
  lightboxCaption: document.getElementById("lightboxCaption"),
  lightboxClose: document.getElementById("lightboxClose"),
};

/** url -> expanded */
const expandedSessions = new Set();

function showError(msg) {
  els.error.hidden = !msg;
  els.error.textContent = msg || "";
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendAction(action, extra = {}) {
  const tab = await activeTab();
  return chrome.runtime.sendMessage({
    type: "UI_ACTION",
    action,
    tabId: tab?.id,
    ...extra,
  });
}

function setStatus(text, kind = "off") {
  els.statusLine.textContent = text;
  els.statusLine.className = `status ${kind}`;
}

function openLightbox(src, caption, gallery = null, index = 0) {
  els.lightboxImg.src = src;
  els.lightboxImg.classList.remove("is-zoomed");
  els.lightboxCaption.textContent = caption || "Click image to zoom";
  if (gallery?.length) {
    els.lightboxImg.dataset.gallery = JSON.stringify(gallery);
    els.lightboxImg.dataset.galleryIndex = String(index);
  } else {
    delete els.lightboxImg.dataset.gallery;
    delete els.lightboxImg.dataset.galleryIndex;
  }
  els.lightbox.hidden = false;
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lightboxImg.src = "";
  els.lightboxImg.classList.remove("is-zoomed");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatWhen(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.hostname + x.pathname.slice(0, 36);
  } catch {
    return String(u || "").slice(0, 48);
  }
}

async function loadBufferList() {
  const res = await sendAction("list_buffer_sessions");
  if (!res?.ok) {
    els.captureList.innerHTML = `<p class="empty">${escapeHtml(res?.error || "Could not load")}</p>`;
    return;
  }
  const sessions = res.sessions || [];
  if (!sessions.length) {
    els.captureList.innerHTML = '<p class="empty">No captures yet</p>';
    return;
  }
  els.captureList.innerHTML = "";
  for (const s of sessions) {
    const wrap = document.createElement("div");
    wrap.className = "session";
    const open = expandedSessions.has(s.url);
    const busy = s.status === "capturing" || s.status === "uploading";

    const head = document.createElement("button");
    head.type = "button";
    head.className = `item session-head${open ? " open" : ""}`;
    const status = s.status || "—";
    head.innerHTML = `<div class="t">${escapeHtml(s.pageTitle || "Application")}
      <span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span></div>
      <div class="m">${escapeHtml(formatWhen(s.updatedAt || s.capturedAt))} · ${s.sliceCount || 0} screenshots</div>
      <div class="m">${escapeHtml(shortUrl(s.url))}</div>
      <div class="expand-hint">${open ? "Hide screenshots" : "Show screenshots"}</div>`;
    head.addEventListener("click", () => {
      if (expandedSessions.has(s.url)) expandedSessions.delete(s.url);
      else expandedSessions.add(s.url);
      void loadBufferList();
    });
    wrap.appendChild(head);

    const actions = document.createElement("div");
    actions.className = "session-actions";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "btn-delete";
    del.textContent = "Delete";
    del.disabled = busy;
    del.title = busy ? "Wait until capture/upload finishes" : "Remove this URL from the buffer";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      void deleteSession(s.url, s.pageTitle);
    });
    actions.appendChild(del);
    wrap.appendChild(actions);

    if (open) {
      const body = document.createElement("div");
      body.className = "session-shots";
      body.innerHTML = '<p class="empty">Loading…</p>';
      wrap.appendChild(body);
      void renderSessionShots(body, s.url, s.pageTitle);
    }

    els.captureList.appendChild(wrap);
  }
}

async function deleteSession(url, title) {
  showError("");
  const label = title || shortUrl(url);
  if (!window.confirm(`Delete buffer for:\n${label}?`)) return;
  const res = await sendAction("delete_buffer_session", { url });
  if (!res?.ok) {
    showError(res?.error || "Delete failed");
    return;
  }
  expandedSessions.delete(url);
  closeLightbox();
  await loadBufferList();
}

async function clearAllBuffer() {
  showError("");
  if (!window.confirm("Clear all local buffer sessions?")) return;
  const res = await sendAction("clear_buffer");
  if (!res?.ok) {
    showError(res?.error || "Clear failed");
    return;
  }
  expandedSessions.clear();
  closeLightbox();
  if (res.skipped) {
    showError(`Cleared idle sessions. ${res.skipped} still in progress.`);
  }
  await loadBufferList();
}

async function renderSessionShots(container, url, title) {
  const res = await sendAction("get_buffer_session", { url });
  if (!res?.ok || !res.session?.images?.length) {
    container.innerHTML = `<p class="empty">${escapeHtml(res?.error || "No screenshots")}</p>`;
    return;
  }
  const images = [...res.session.images].sort(
    (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)
  );
  const gallery = images.map((i) => i.dataBase64);
  container.innerHTML = "";
  images.forEach((img, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "thumb";
    btn.innerHTML = `<img alt="Screenshot ${idx + 1}" loading="lazy" /><span>#${idx + 1}</span>`;
    const el = btn.querySelector("img");
    el.src = img.dataBase64;
    btn.addEventListener("click", () => {
      openLightbox(
        img.dataBase64,
        `${title || "Capture"} · ${idx + 1}/${images.length} — click to zoom`,
        gallery,
        idx
      );
      els.lightboxImg.dataset.galleryTitle = title || "Capture";
    });
    container.appendChild(btn);
  });
}

/** Last tab we successfully resolved — avoids No flicker if query briefly fails. */
let trackedTabId = null;
/** Once Yes on this tab+host, do not paint No until tab/host changes. */
let stickySubmitYes = false;
let stickySubmitCount = 0;
let stickyHost = "";

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function paintSubmitDetected(isApplyPage, submitCount, { force = false } = {}) {
  if (!els.submitDetected) return;
  if (isApplyPage) {
    stickySubmitYes = true;
    stickySubmitCount = Math.max(1, submitCount || stickySubmitCount || 1);
    els.submitDetected.textContent = `Yes (${stickySubmitCount})`;
    els.submitDetected.className = "yes";
    return;
  }
  // Never demote Yes → No from a transient poll (unless forced tab/host change).
  if (stickySubmitYes && !force) {
    els.submitDetected.textContent = `Yes (${stickySubmitCount || 1})`;
    els.submitDetected.className = "yes";
    return;
  }
  stickySubmitYes = false;
  stickySubmitCount = 0;
  els.submitDetected.textContent = "No";
  els.submitDetected.className = "no";
}

async function resolveTrackedTab() {
  const tab = await activeTab();
  if (tab?.id != null) {
    const h = hostOf(tab.url || "");
    if (trackedTabId !== tab.id || (h && stickyHost && h !== stickyHost)) {
      stickySubmitYes = false;
      stickySubmitCount = 0;
    }
    trackedTabId = tab.id;
    if (h) stickyHost = h;
  }
  return tab;
}

async function refreshSubmitStatus() {
  const tab = await resolveTrackedTab();
  if (tab?.id == null && trackedTabId == null) return null;
  const tabId = tab?.id ?? trackedTabId;
  const state = await chrome.runtime.sendMessage({
    type: "GET_RECORDING_STATE",
    url: tab?.url || "",
    tabId,
  });
  paintSubmitDetected(Boolean(state?.isApplyPage), state?.submitCount || 0);
  return state;
}

async function refresh() {
  showError("");
  const state = await refreshSubmitStatus();

  const on = Boolean(state?.captureEnabled || state?.recordingEnabled);
  els.btnToggle.textContent = on ? "On" : "Off";
  els.btnToggle.className = `toggle ${on ? "on" : "off"}`;

  if (!on) {
    setStatus("Capture is off", "off");
  } else if (state?.isApplyPage) {
    setStatus("Ready — Submit click captures, then submits automatically", "ready");
  } else {
    setStatus("Waiting for a Submit button on this page", "off");
  }

  await loadBufferList();
}

els.btnToggle.addEventListener("click", async () => {
  await sendAction("toggle_capture");
  await refresh();
});

els.btnReloadList.addEventListener("click", () => void loadBufferList());
els.btnClearBuffer?.addEventListener("click", () => void clearAllBuffer());

els.openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

els.lightboxClose.addEventListener("click", closeLightbox);
els.lightbox.addEventListener("click", (e) => {
  if (e.target === els.lightbox) closeLightbox();
});
els.lightboxImg.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!els.lightboxImg.classList.contains("is-zoomed")) {
    els.lightboxImg.classList.add("is-zoomed");
    return;
  }
  try {
    const gallery = JSON.parse(els.lightboxImg.dataset.gallery || "[]");
    if (gallery.length > 1) {
      let idx = Number(els.lightboxImg.dataset.galleryIndex || 0) + 1;
      if (idx >= gallery.length) idx = 0;
      els.lightboxImg.dataset.galleryIndex = String(idx);
      els.lightboxImg.src = gallery[idx];
      els.lightboxImg.classList.remove("is-zoomed");
      const title = els.lightboxImg.dataset.galleryTitle || "Capture";
      els.lightboxCaption.textContent = `${title} · ${idx + 1}/${gallery.length} — click to zoom`;
      return;
    }
  } catch {
    // ignore
  }
  els.lightboxImg.classList.remove("is-zoomed");
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "APPLY_PAGE_STATE") {
    // Ignore other tabs — that was the Yes/No flicker.
    void (async () => {
      const tab = await resolveTrackedTab();
      const tabId = tab?.id ?? trackedTabId;
      if (tabId != null && message.tabId != null && message.tabId !== tabId) {
        return;
      }
      // Positive updates only from broadcast (sticky Yes).
      if (message.isApplyPage) {
        paintSubmitDetected(true, message.submitCount || 1);
      }
    })();
    return;
  }
  if (
    message?.type === "BUFFER_CAPTURE_PROGRESS" ||
    message?.type === "BUFFER_CAPTURE_UPDATED"
  ) {
    if (message.url) expandedSessions.add(message.url);
    paintSubmitDetected(true, 1);
    void loadBufferList();
    if (message.type === "BUFFER_CAPTURE_PROGRESS") {
      setStatus(
        `Capturing… ${message.sliceCount || 0}/${message.totalHint || "?"}`,
        "warn"
      );
    }
    if (message.type === "BUFFER_CAPTURE_UPDATED") {
      setStatus("Uploaded — form submitting…", "ready");
    }
  }
});

// Slow poll for the active tab only (sticky state — no Yes/No thrash).
setInterval(() => {
  void refreshSubmitStatus().catch(() => {});
}, 4000);

void refresh().catch((err) => showError(err?.message || String(err)));
