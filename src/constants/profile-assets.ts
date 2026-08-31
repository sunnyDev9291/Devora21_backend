import { env } from "../config/env";

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const PROMPT_MAX_BYTES = 512 * 1024;
export const CUSTOM_PROMPT_MAX_CHARS = 50_000;

export const AVATAR_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export const RESUME_TEMPLATE_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const PROMPT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
]);

export function buildProfileAvatarUrl(): string {
  return `${env.API_BASE_URL}/auth/profile/avatar`;
}

export function avatarExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export function promptExtension(mimeType: string, originalName: string): string {
  const lower = originalName.toLowerCase();
  if (lower.endsWith(".md")) {
    return "md";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (mimeType === "application/json") {
    return "json";
  }
  if (mimeType === "text/markdown") {
    return "md";
  }
  return "txt";
}

export function avatarContentType(key: string): string {
  if (key.endsWith(".png")) {
    return "image/png";
  }
  if (key.endsWith(".webp")) {
    return "image/webp";
  }
  if (key.endsWith(".gif")) {
    return "image/gif";
  }
  return "image/jpeg";
}
