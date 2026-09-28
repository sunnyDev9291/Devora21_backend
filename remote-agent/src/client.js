async function apiRequest(config, method, pathname, body) {
  const url = `${config.apiBaseUrl}${pathname}`;
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${config.deviceSecret}`,
    "User-Agent": "Devora21RemoteAgent/1.0",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const message =
      (json && (json.message || json.error)) ||
      `HTTP ${response.status} ${response.statusText}`;
    const err = new Error(String(message));
    err.status = response.status;
    err.body = json || text;
    throw err;
  }

  return json;
}

async function pullQueue(config, limit = 10) {
  return apiRequest(config, "GET", `/resume/remote-queue?limit=${limit}`);
}

async function ackDelivery(config, deliveryId, status, error) {
  const body = { status };
  if (status === "failed" && error) {
    body.error = String(error).slice(0, 500);
  }
  return apiRequest(
    config,
    "POST",
    `/resume/remote-queue/${encodeURIComponent(deliveryId)}/ack`,
    body
  );
}

module.exports = { pullQueue, ackDelivery };
