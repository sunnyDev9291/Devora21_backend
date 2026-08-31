import { env } from "./env";

const LOCAL_DEV_ORIGIN = "http://localhost:3000";

function normalizeOrigin(url: string): string {
  return new URL(url).origin;
}

/** Origins allowed for CORS and OAuth redirect validation. */
export function getAllowedFrontendOrigins(): string[] {
  const origins = new Set<string>();

  origins.add(normalizeOrigin(env.FRONTEND_URL));

  if (env.FRONTEND_URLS) {
    for (const entry of env.FRONTEND_URLS.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) {
        continue;
      }
      origins.add(normalizeOrigin(trimmed));
    }
  }

  origins.add(LOCAL_DEV_ORIGIN);

  return [...origins];
}

export const ALLOWED_FRONTEND_ORIGINS = getAllowedFrontendOrigins();
