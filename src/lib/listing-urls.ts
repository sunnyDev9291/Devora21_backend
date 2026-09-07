import { prisma } from "./prisma";
import { AppError } from "../middleware/errorHandler";

export const LISTING_URL_PLATFORMS = [
  "builtin",
  "hiringcafe",
  "workable",
  "workingnomads",
] as const;

export type ListingUrlPlatform = (typeof LISTING_URL_PLATFORMS)[number];

export type ListingUrls = Partial<Record<ListingUrlPlatform, string>>;

const FLAT_FIELD_BY_PLATFORM: Record<ListingUrlPlatform, string> = {
  builtin: "listingUrl_builtin",
  hiringcafe: "listingUrl_hiringcafe",
  workable: "listingUrl_workable",
  workingnomads: "listingUrl_workingnomads",
};

function fieldError(field: string, message: string): AppError {
  return new AppError(422, message, { [field]: [message] });
}

function isListingUrlPlatform(value: string): value is ListingUrlPlatform {
  return (LISTING_URL_PLATFORMS as readonly string[]).includes(value);
}

export function isValidListingUrlForPlatform(
  platform: ListingUrlPlatform,
  value: string
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  switch (platform) {
    case "builtin":
      return (
        (host === "builtin.com" || host.endsWith(".builtin.com")) &&
        parsed.pathname.startsWith("/jobs")
      );
    case "hiringcafe":
      return (
        (host === "hiringcafe.com" || host.endsWith(".hiringcafe.com")) &&
        !parsed.pathname.startsWith("/job/")
      );
    case "workable":
      return (
        (host === "jobs.workable.com" || host.endsWith(".jobs.workable.com")) &&
        parsed.pathname.startsWith("/search")
      );
    case "workingnomads":
      return (
        (host === "workingnomads.com" ||
          host.endsWith(".workingnomads.com")) &&
        parsed.pathname === "/jobs"
      );
    default:
      return false;
  }
}

/** Normalize DB/JSON value into a compact ListingUrls object (no blank values). */
export function normalizeListingUrls(value: unknown): ListingUrls {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: ListingUrls = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isListingUrlPlatform(key)) {
      continue;
    }
    if (typeof raw !== "string") {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    result[key] = trimmed;
  }
  return result;
}

export function listingUrlsForResponse(
  value: unknown
): ListingUrls | undefined {
  const normalized = normalizeListingUrls(value);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function coerceListingUrlsObject(jsonRaw: unknown, field: string): unknown {
  if (typeof jsonRaw === "string") {
    const trimmed = jsonRaw.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      throw fieldError(field, "listingUrls must be valid JSON");
    }
  }
  return jsonRaw;
}

/**
 * Parse listing URL patches from JSON or multipart body.
 * Accepts `listingUrls` / `listing_urls` as an object or JSON string,
 * and/or flat `listingUrl_*` fields.
 * Returns undefined when no listing URL fields were sent.
 * Empty string values mean "clear this platform".
 * Omitted platforms keep their previously stored value.
 */
export function parseListingUrlsPatch(
  body: Record<string, unknown>
): ListingUrls | undefined {
  const patch: ListingUrls = {};
  let touched = false;

  const jsonRaw = body.listingUrls ?? body.listing_urls;
  if (jsonRaw !== undefined && jsonRaw !== null) {
    touched = true;
    const parsed = coerceListingUrlsObject(jsonRaw, "listingUrls");

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw fieldError("listingUrls", "listingUrls must be a JSON object");
    }

    for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isListingUrlPlatform(key)) {
        continue;
      }
      if (raw === null || raw === undefined) {
        patch[key] = "";
        continue;
      }
      if (typeof raw !== "string") {
        throw fieldError("listingUrls", `listingUrls.${key} must be a string`);
      }
      patch[key] = raw.trim();
    }
  }

  for (const platform of LISTING_URL_PLATFORMS) {
    const flatKey = FLAT_FIELD_BY_PLATFORM[platform];
    const raw = body[flatKey];
    if (raw === undefined) {
      continue;
    }
    touched = true;
    if (typeof raw !== "string") {
      throw fieldError(flatKey, `${flatKey} must be a string`);
    }
    patch[platform] = raw.trim();
  }

  if (!touched) {
    return undefined;
  }

  for (const platform of LISTING_URL_PLATFORMS) {
    if (!(platform in patch)) {
      continue;
    }
    const url = patch[platform] ?? "";
    if (!url) {
      continue;
    }
    if (!isValidListingUrlForPlatform(platform, url)) {
      const field =
        jsonRaw !== undefined ? `listingUrls.${platform}` : FLAT_FIELD_BY_PLATFORM[platform];
      throw fieldError(
        field,
        `Invalid ${platform} listing URL (must be an https listing page)`
      );
    }
  }

  return patch;
}

/** Merge patch into existing listing URLs. Empty string clears that platform. */
export function mergeListingUrls(
  existing: unknown,
  patch: ListingUrls
): ListingUrls {
  const merged: ListingUrls = { ...normalizeListingUrls(existing) };

  for (const platform of LISTING_URL_PLATFORMS) {
    if (!(platform in patch)) {
      continue;
    }
    const next = (patch[platform] ?? "").trim();
    if (!next) {
      delete merged[platform];
    } else {
      merged[platform] = next;
    }
  }

  return merged;
}

/**
 * Prefer an explicit request URL; otherwise use the user's saved profile listing URL.
 */
export async function resolveListingUrlForUser(
  userId: string,
  platform: ListingUrlPlatform,
  requestedUrl?: string
): Promise<string> {
  const fromRequest = requestedUrl?.trim();
  if (fromRequest) {
    return fromRequest;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { listingUrls: true },
  });

  const saved = normalizeListingUrls(user?.listingUrls)[platform];
  if (!saved) {
    throw new AppError(
      422,
      `No ${platform} listing URL saved on your profile`
    );
  }

  return saved;
}
