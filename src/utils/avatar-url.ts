import { URL } from "node:url";

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
}

export function validateHttpsAvatarUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid avatar URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Avatar URL must use HTTPS");
  }

  if (isPrivateHost(parsed.hostname)) {
    throw new Error("Avatar URL is not allowed");
  }

  return parsed.toString();
}
