/**
 * Get on Board public Search API — jobs by country (ISO alpha-2).
 * Docs: https://www.getonbrd.com/api-doc.html
 * Endpoint: GET /api/v0/search/jobs
 *
 * Official rule: do NOT pass `remote` and `country_code` together
 * (422 Localization conflict). Filter remote + published_at client-side.
 */

export type GetOnBoardJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type GetOnBoardCrawlResult = {
  sourceUrl: string;
  platform: "getonboard";
  country: string;
  countryCode: string;
  pagesScraped: number;
  totalCount: number;
  jobs: GetOnBoardJobListingItem[];
};

export const GETONBOARD_SEARCH_URL =
  "https://www.getonbrd.com/api/v0/search/jobs";
export const DEFAULT_GETONBOARD_COUNTRY = "Argentina";
export const GETONBOARD_PER_PAGE = 120;
/** Safety cap — country lists are usually a few pages at per_page=120. */
export const GETONBOARD_MAX_PAGES = 20;

/**
 * Countries shown in Get on Board's location filter UI ("Jobs by country").
 * For these: run country_code mode + remote=true mode.
 * For all other countries (e.g. Brazil): remote=true mode only.
 */
export const GETONBOARD_COUNTRY_FILTER_CODES = [
  "AR", // Argentina
  "CL", // Chile
  "CO", // Colombia
  "MX", // Mexico
  "PE", // Peru
] as const;

export type GetOnBoardCountryFilterCode =
  (typeof GETONBOARD_COUNTRY_FILTER_CODES)[number];

export function supportsGetOnBoardCountryMode(countryCode: string): boolean {
  const code = countryCode.toUpperCase();
  return (GETONBOARD_COUNTRY_FILTER_CODES as readonly string[]).includes(code);
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Extra aliases beyond Intl.DisplayNames English region names. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US",
  us: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united states": "US",
  "united states of america": "US",
  uk: "GB",
  "u.k.": "GB",
  "united kingdom": "GB",
  "great britain": "GB",
  england: "GB",
  bolivia: "BO",
  "bolivia (plurinational state of)": "BO",
  venezuela: "VE",
  "venezuela (bolivarian republic of)": "VE",
  russia: "RU",
  "russian federation": "RU",
  "south korea": "KR",
  "korea, republic of": "KR",
  "north korea": "KP",
  vietnam: "VN",
  "viet nam": "VN",
  czechia: "CZ",
  "czech republic": "CZ",
  taiwan: "TW",
  "taiwan, province of china": "TW",
  palestine: "PS",
  "syria": "SY",
  iran: "IR",
  "ivory coast": "CI",
  "cote d'ivoire": "CI",
  "côte d'ivoire": "CI",
};

let nameToIso2Cache: Map<string, string> | null = null;

function buildNameToIso2Map(): Map<string, string> {
  const map = new Map<string, string>();
  const display = new Intl.DisplayNames(["en"], { type: "region" });

  for (let a = 65; a <= 90; a += 1) {
    for (let b = 65; b <= 90; b += 1) {
      const code = String.fromCharCode(a, b);
      const name = display.of(code);
      if (!name || name === code) continue;
      map.set(normalizeCountryKey(name), code);
    }
  }

  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) {
    map.set(normalizeCountryKey(alias), code);
  }

  return map;
}

function getNameToIso2Map(): Map<string, string> {
  if (!nameToIso2Cache) {
    nameToIso2Cache = buildNameToIso2Map();
  }
  return nameToIso2Cache;
}

function normalizeCountryKey(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeGetOnBoardCountry(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function isValidGetOnBoardCountry(value: string): boolean {
  const country = normalizeGetOnBoardCountry(value);
  if (country.length < 2 || country.length > 80) return false;
  if (/^https?:\/\//i.test(country)) return false;
  return /^[\p{L}\p{M}0-9 .,'()-]+$/u.test(country);
}

/**
 * Resolve user country name (or ISO alpha-2) to ISO 3166-1 alpha-2.
 * Live API requires alpha-2 (not alpha-3); OpenAPI examples showing CHL are outdated.
 */
export function resolveGetOnBoardCountryCode(countryRaw: string): string | null {
  const country = normalizeGetOnBoardCountry(countryRaw);
  if (!country) return null;

  if (/^[A-Za-z]{2}$/.test(country)) {
    const code = country.toUpperCase();
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    const name = display.of(code);
    if (name && name !== code) return code;
  }

  return getNameToIso2Map().get(normalizeCountryKey(country)) ?? null;
}

export function countryDisplayNameForCode(code: string): string {
  const display = new Intl.DisplayNames(["en"], { type: "region" });
  return display.of(code.toUpperCase()) || code.toUpperCase();
}

export function getonboardSourceKey(countryCode: string): string {
  return `getonboard:${countryCode.toUpperCase()}`;
}

/** published_at is Unix epoch seconds per Get on Board API. */
export function parseGetOnBoardPublishedAtMs(publishedAt: unknown): number | null {
  if (typeof publishedAt !== "number" || !Number.isFinite(publishedAt)) {
    return null;
  }
  return publishedAt > 1e12 ? publishedAt : publishedAt * 1000;
}

export function isWithinLast24Hours(
  publishedAt: unknown,
  nowMs = Date.now()
): boolean {
  const ms = parseGetOnBoardPublishedAtMs(publishedAt);
  if (ms === null) return false;
  return ms >= nowMs - ONE_DAY_MS;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isGetOnBoardRemoteJob(attributes: {
  remote?: unknown;
  remote_modality?: unknown;
}): boolean {
  if (attributes.remote === true) return true;
  const modality = asString(attributes.remote_modality).toLowerCase();
  return (
    modality === "fully_remote" ||
    modality === "remote_local" ||
    modality === "remote"
  );
}

function companyNameFromAttributes(attributes: Record<string, unknown>): string {
  const company = attributes.company;
  if (!company || typeof company !== "object") return "";
  const data = (company as { data?: unknown }).data;
  if (!data || typeof data !== "object") return "";
  const nested = data as { attributes?: unknown; id?: unknown };
  const attrs = nested.attributes;
  if (attrs && typeof attrs === "object") {
    const name = asString((attrs as { name?: unknown }).name);
    if (name) return name;
  }
  return asString(nested.id);
}

export function toAbsoluteGetOnBoardJobUrl(
  publicUrl: string,
  jobId: string
): string {
  if (publicUrl) {
    try {
      const url = new URL(publicUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      const host = url.hostname.toLowerCase();
      if (host !== "www.getonbrd.com" && host !== "getonbrd.com") {
        return "";
      }
      url.protocol = "https:";
      return url.href;
    } catch {
      // fall through
    }
  }
  if (!jobId) return "";
  return `https://www.getonbrd.com/jobs/${encodeURIComponent(jobId)}`;
}

export type GetOnBoardApiJob = {
  id?: unknown;
  type?: unknown;
  attributes?: Record<string, unknown> | null;
  links?: { public_url?: unknown } | null;
};

export function mapGetOnBoardApiJob(
  raw: GetOnBoardApiJob
): GetOnBoardJobListingItem | null {
  const jobId = asString(raw.id);
  const attributes =
    raw.attributes && typeof raw.attributes === "object"
      ? raw.attributes
      : {};
  const jobTitle = asString(attributes.title);
  const companyName = companyNameFromAttributes(attributes);
  const publicUrl = asString(raw.links?.public_url);
  const jobUrl = toAbsoluteGetOnBoardJobUrl(publicUrl, jobId);

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

export type GetOnBoardSearchMode = "country" | "remote";

/**
 * Build Search API URL for one mode.
 * Official rule: never pass country_code and remote in the same request (422).
 * Docs say: if you need both lists, make two requests and merge.
 */
export function buildGetOnBoardSearchUrl(
  mode: GetOnBoardSearchMode,
  page: number,
  countryCode?: string
): string {
  const url = new URL(GETONBOARD_SEARCH_URL);
  url.searchParams.set("per_page", String(GETONBOARD_PER_PAGE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("lang", "en");
  url.searchParams.append("expand[]", "company");

  if (mode === "country") {
    if (!countryCode) {
      throw new Error("countryCode is required for Get on Board country mode");
    }
    url.searchParams.set("country_code", countryCode.toUpperCase());
  } else {
    url.searchParams.set("remote", "true");
  }

  return url.href;
}
