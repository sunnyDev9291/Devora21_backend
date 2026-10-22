/**
 * Persistent capture buffer keyed by page URL (chrome.storage.local).
 * Max 10 URL sessions — FIFO eviction of oldest idle sessions.
 */

const STORAGE_KEY = "captureBufferV1";
const MAX_URLS = 10;

export function normalizeCaptureUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return String(url || "").trim();
  }
}

async function readStore() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const store = data[STORAGE_KEY] || { sessions: {}, order: [] };
  if (!store.sessions || typeof store.sessions !== "object") store.sessions = {};
  if (!Array.isArray(store.order)) store.order = [];
  return store;
}

async function writeStore(store) {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

function touchOrder(order, urlKey) {
  const next = order.filter((u) => u !== urlKey);
  next.push(urlKey);
  return next;
}

/**
 * Evict oldest sessions that are not capturing/uploading until length <= MAX_URLS.
 */
function evictIfNeeded(store, protectUrl) {
  while (store.order.length > MAX_URLS) {
    const oldest = store.order.find(
      (u) =>
        u !== protectUrl &&
        store.sessions[u] &&
        store.sessions[u].status !== "capturing" &&
        store.sessions[u].status !== "uploading"
    );
    if (!oldest) break;
    store.order = store.order.filter((u) => u !== oldest);
    delete store.sessions[oldest];
  }
}

/** Start or replace a session for this URL (clears prior images). */
export async function beginCaptureSession({
  url,
  pageTitle,
  clientCaptureId,
}) {
  const urlKey = normalizeCaptureUrl(url);
  const store = await readStore();
  store.sessions[urlKey] = {
    url: urlKey,
    pageTitle: pageTitle || "",
    clientCaptureId,
    capturedAt: Date.now(),
    updatedAt: Date.now(),
    status: "capturing",
    images: [],
    serverSessionId: null,
    uploadError: null,
  };
  store.order = touchOrder(store.order, urlKey);
  evictIfNeeded(store, urlKey);
  await writeStore(store);
  return store.sessions[urlKey];
}

/** Append one processed slice immediately (during scroll). */
export async function appendCaptureSlice(url, image) {
  const urlKey = normalizeCaptureUrl(url);
  const store = await readStore();
  const session = store.sessions[urlKey];
  if (!session) return null;
  session.images = session.images || [];
  session.images.push({
    sortOrder: image.sortOrder,
    dataBase64: image.dataBase64,
    width: image.width,
    height: image.height,
  });
  session.updatedAt = Date.now();
  session.status = "capturing";
  await writeStore(store);
  return session;
}

export async function setCaptureSessionStatus(url, status, extra = {}) {
  const urlKey = normalizeCaptureUrl(url);
  const store = await readStore();
  const session = store.sessions[urlKey];
  if (!session) return null;
  session.status = status;
  session.updatedAt = Date.now();
  Object.assign(session, extra);
  await writeStore(store);
  return session;
}

export async function getCaptureSession(url) {
  const urlKey = normalizeCaptureUrl(url);
  const store = await readStore();
  return store.sessions[urlKey] || null;
}

export async function listCaptureSessions() {
  const store = await readStore();
  return store.order
    .map((u) => store.sessions[u])
    .filter(Boolean)
    .reverse(); // newest first for UI
}

export async function isUrlBusy(url) {
  const s = await getCaptureSession(url);
  return Boolean(
    s && (s.status === "capturing" || s.status === "uploading")
  );
}

/** Delete one URL session. Refuses busy sessions unless force=true. */
export async function deleteCaptureSession(url, { force = false } = {}) {
  const urlKey = normalizeCaptureUrl(url);
  const store = await readStore();
  const session = store.sessions[urlKey];
  if (!session) return { ok: false, error: "Session not found" };
  if (
    !force &&
    (session.status === "capturing" || session.status === "uploading")
  ) {
    return { ok: false, error: "Capture in progress — wait or force delete." };
  }
  delete store.sessions[urlKey];
  store.order = store.order.filter((u) => u !== urlKey);
  await writeStore(store);
  return { ok: true };
}

/** Clear all buffer sessions. Skips busy ones unless force=true. */
export async function clearCaptureBuffer({ force = false } = {}) {
  const store = await readStore();
  if (force) {
    store.sessions = {};
    store.order = [];
    await writeStore(store);
    return { ok: true, cleared: true, skipped: 0 };
  }
  let skipped = 0;
  const nextSessions = {};
  const nextOrder = [];
  for (const u of store.order) {
    const s = store.sessions[u];
    if (!s) continue;
    if (s.status === "capturing" || s.status === "uploading") {
      nextSessions[u] = s;
      nextOrder.push(u);
      skipped += 1;
      continue;
    }
  }
  store.sessions = nextSessions;
  store.order = nextOrder;
  await writeStore(store);
  return { ok: true, cleared: true, skipped };
}

export { MAX_URLS };
