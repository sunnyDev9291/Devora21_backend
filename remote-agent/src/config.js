const fs = require("fs");
const path = require("path");
const os = require("os");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function loadConfig() {
  const root = path.resolve(__dirname, "..");
  loadDotEnv(path.join(root, ".env"));

  const apiBaseUrl = (process.env.API_BASE_URL || "").trim().replace(/\/$/, "");
  if (!apiBaseUrl) {
    throw new Error("Missing required env: API_BASE_URL");
  }

  const deviceSecret = requireEnv("DEVICE_SECRET");
  if (!deviceSecret.startsWith("dvrd_")) {
    throw new Error("DEVICE_SECRET must start with dvrd_");
  }

  const saveDir =
    (process.env.SAVE_DIR || "").trim() ||
    path.join(os.homedir(), "Downloads", "Devora21");

  const pollIntervalMs = Math.max(
    2000,
    Number(process.env.POLL_INTERVAL_MS || 5000) || 5000
  );

  const overwrite = String(process.env.OVERWRITE || "true").toLowerCase() !== "false";

  return {
    apiBaseUrl,
    deviceSecret,
    saveDir,
    pollIntervalMs,
    overwrite,
  };
}

module.exports = { loadConfig };
