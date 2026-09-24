/**
 * Himalayas free public Jobs API — search by country, map to crawl items.
 * Docs: https://himalayas.app/docs/remote-jobs-api
 */

export type HimalayasJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type HimalayasCrawlResult = {
  sourceUrl: string;
  platform: "himalayas";
  pagesScraped: number;
  totalCount: number;
  jobs: HimalayasJobListingItem[];
};

export const HIMALAYAS_SEARCH_URL = "https://himalayas.app/jobs/api/search";
export const DEFAULT_HIMALAYAS_COUNTRY = "Argentina";

/** Safety cap — with sort=recent we usually stop earlier via 24h cutoff. */
export const HIMALAYAS_MAX_PAGES = 100;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type HimalayasApiJob = {
  title?: unknown;
  companyName?: unknown;
  applicationLink?: unknown;
  guid?: unknown;
  pubDate?: unknown;
};

type HimalayasSearchResponse = {
  jobs?: unknown;
  totalCount?: unknown;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** pubDate may be unix seconds or ms depending on API revision. */
export function parseHimalayasPubDateMs(pubDate: unknown): number | null {
  if (typeof pubDate !== "number" || !Number.isFinite(pubDate)) {
    return null;
  }
  // Values > 1e12 are already milliseconds.
  return pubDate > 1e12 ? pubDate : pubDate * 1000;
}

export function isWithinLast24Hours(pubDate: unknown, nowMs = Date.now()): boolean {
  const ms = parseHimalayasPubDateMs(pubDate);
  if (ms === null) return false;
  return ms >= nowMs - ONE_DAY_MS;
}

export function normalizeHimalayasCountry(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function isValidHimalayasCountry(value: string): boolean {
  const country = normalizeHimalayasCountry(value);
  if (country.length < 2 || country.length > 80) return false;
  // Country name / slug — letters, spaces, hyphens, apostrophes (not a URL).
  if (/^https?:\/\//i.test(country)) return false;
  return /^[\p{L}\p{M}0-9 .,'()-]+$/u.test(country);
}

export function himalayasSourceKey(country: string): string {
  return `himalayas:${normalizeHimalayasCountry(country)}`;
}

/** Stable id from guid / applicationLink path (not array index). */
export function himalayasJobIdFromLinks(guid: string, applicationLink: string): string {
  const candidate = guid || applicationLink;
  if (!candidate) return "";
  try {
    const path = new URL(candidate).pathname;
    const parts = path.split("/").filter(Boolean);
    const slug = parts[parts.length - 1] || "";
    if (slug) return decodeURIComponent(slug);
  } catch {
    // fall through
  }
  return candidate;
}

export function toAbsoluteHimalayasJobUrl(guid: string, applicationLink: string): string {
  const raw = applicationLink || guid;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host !== "himalayas.app" && !host.endsWith(".himalayas.app")) {
      return "";
    }
    return url.href;
  } catch {
    return "";
  }
}

export function mapHimalayasApiJob(raw: HimalayasApiJob): HimalayasJobListingItem | null {
  const jobTitle = asString(raw.title);
  const companyName = asString(raw.companyName);
  const guid = asString(raw.guid);
  const applicationLink = asString(raw.applicationLink);
  const jobUrl = toAbsoluteHimalayasJobUrl(guid, applicationLink);
  const jobId = himalayasJobIdFromLinks(guid, applicationLink);

  if (!jobTitle || !jobUrl || !jobId) {
    return null;
  }

  return {
    jobId,
    companyName,
    jobTitle,
    jobUrl,
  };
}

export function buildHimalayasSearchUrl(country: string, page: number): string {
  const url = new URL(HIMALAYAS_SEARCH_URL);
  url.searchParams.set("country", normalizeHimalayasCountry(country));
  url.searchParams.set("sort", "recent");
  url.searchParams.set("page", String(page));
  return url.href;
}
