import dns from "node:dns";
import https from "node:https";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";

dns.setDefaultResultOrder("ipv4first");

const ZYTE_EXTRACT_URL = "https://api.zyte.com/v1/extract";
const ZYTE_TIMEOUT_MS = 120_000;
const ZYTE_MAX_ATTEMPTS = 3;
const ZYTE_RETRY_DELAY_MS = 750;

type ZyteJson = Record<string, unknown>;

function zyteAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function networkErrorCode(err: unknown): string {
  const error = err as {
    code?: string;
    cause?: { code?: string; message?: string };
    message?: string;
    name?: string;
  };
  return (
    error.cause?.code ||
    error.code ||
    error.name ||
    error.message ||
    "unknown"
  );
}

function isTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = networkErrorCode(err).toLowerCase();
  return (
    message.includes("TimeoutError") ||
    message.includes("aborted") ||
    message.toLowerCase().includes("timeout") ||
    code.includes("timeout") ||
    code.includes("aborted")
  );
}

function isRetryableNetworkError(err: unknown): boolean {
  const code = networkErrorCode(err).toUpperCase();
  return (
    code.includes("ECONNRESET") ||
    code.includes("ECONNREFUSED") ||
    code.includes("ENOTFOUND") ||
    code.includes("EAI_AGAIN") ||
    code.includes("ENETUNREACH") ||
    code.includes("EHOSTUNREACH") ||
    code.includes("UND_ERR") ||
    code.includes("FETCH") ||
    code.includes("SOCKET") ||
    /fetch failed/i.test(err instanceof Error ? err.message : String(err))
  );
}

function postZyteOnce(body: ZyteJson): Promise<{ status: number; payload: ZyteJson }> {
  if (!env.ZYTE_API_KEY) {
    throw new AppError(503, "Zyte API is not configured");
  }

  const payload = JSON.stringify(body);
  const url = new URL(ZYTE_EXTRACT_URL);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        family: 4,
        timeout: ZYTE_TIMEOUT_MS,
        headers: {
          Authorization: zyteAuthHeader(env.ZYTE_API_KEY as string),
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode ?? 0,
              payload: text ? (JSON.parse(text) as ZyteJson) : {},
            });
          } catch {
            reject(new AppError(502, "Zyte returned an invalid response"));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("TimeoutError"));
    });
    request.on("error", reject);
    request.write(payload);
    request.end();
  });
}

export async function zyteExtract(body: ZyteJson): Promise<ZyteJson> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ZYTE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { status, payload } = await postZyteOnce(body);
      if (status >= 200 && status < 300) {
        return payload;
      }

      const detail =
        asString(payload.error) ||
        asString(payload.detail) ||
        `Zyte request failed (${status})`;

      if (status >= 500 && attempt < ZYTE_MAX_ATTEMPTS) {
        await sleep(ZYTE_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw new AppError(status === 401 || status === 403 ? 502 : 502, detail);
    } catch (err) {
      lastError = err;
      if (err instanceof AppError) {
        throw err;
      }
      if (isTimeoutError(err)) {
        throw new AppError(504, "Timed out while contacting Zyte");
      }
      if (isRetryableNetworkError(err) && attempt < ZYTE_MAX_ATTEMPTS) {
        console.warn(
          `Zyte network error (${networkErrorCode(err)}); retry ${attempt}/${ZYTE_MAX_ATTEMPTS}`
        );
        await sleep(ZYTE_RETRY_DELAY_MS * attempt);
        continue;
      }
      break;
    }
  }

  const code = networkErrorCode(lastError);
  console.error("Zyte request failed:", code, lastError);
  throw new AppError(502, `Could not reach Zyte (${code})`);
}

export async function fetchZyteBrowserHtml(
  targetUrl: string,
  emptyPageMessage: string
): Promise<{ html: string; pageUrl: string }> {
  const payload = await zyteExtract({
    url: targetUrl,
    browserHtml: true,
  });

  const html = asString(payload.browserHtml);
  if (!html) {
    throw new AppError(502, emptyPageMessage);
  }

  return {
    html,
    pageUrl: asString(payload.url) || targetUrl,
  };
}
