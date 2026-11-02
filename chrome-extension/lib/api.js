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
    const details = body?.details || body?.errors;
    let detailMsg = "";
    if (details && typeof details === "object") {
      const parts = [];
      for (const [key, val] of Object.entries(details)) {
        const text = Array.isArray(val) ? val.join("; ") : String(val || "");
        if (text) parts.push(`${key}: ${text}`);
      }
      if (parts.some((p) => /dataBase64|too big|max/i.test(p))) {
        detailMsg = "Screenshot file is too large. Try a smaller crop or JPEG.";
      } else if (parts.length) {
        detailMsg = parts.slice(0, 3).join(" · ");
      }
    }
    const msg =
      detailMsg || body?.error || body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export function fetchMe() {
  return request("/extension/me");
}

/** Apply-gate screenshot → ApplicationCaptureSession. */
export function createApplicationCapture(payload) {
  return request("/extension/application-captures", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
