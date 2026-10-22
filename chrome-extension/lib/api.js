import { getSettings } from "./storage.js";

async function request(path, options = {}) {
  const settings = await getSettings();
  if (!settings.apiKey?.trim()) {
    throw new Error("API key not configured. Open extension Options.");
  }
  const base = String(settings.apiBaseUrl || "").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${settings.apiKey.trim()}`,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) {
    const msg = body?.error || body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export function fetchMe() {
  return request("/extension/me");
}

export function uploadApplicationCapture(payload) {
  return request("/extension/application-captures", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listCaptures(opts = {}) {
  const page = opts.page || 1;
  const limit = opts.limit || 20;
  return request(
    `/extension/application-captures?page=${page}&limit=${limit}`
  );
}

export function getCapture(id) {
  return request(`/extension/application-captures/${id}`);
}

export function deleteCapture(id) {
  return request(`/extension/application-captures/${id}`, {
    method: "DELETE",
  });
}

/** @deprecated legacy live Q&A */
export function syncApplicationQa(payload) {
  return request("/extension/application-qa/sync", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
