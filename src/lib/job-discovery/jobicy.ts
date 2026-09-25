/**
 * Jobicy free public Remote Jobs API — filter by geo (country/region slug).
 * Docs: https://jobicy.com/jobs-rss-feed
 * GitHub: https://github.com/Jobicy/remote-jobs-api
 *
 * Endpoint: GET https://jobicy.com/api/v2/remote-jobs
 * Taxonomies: ?get=locations → geoSlug values for the `geo` param.
 * Already remote-only. Max count 200; no pagination.
 */

export type JobicyJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type JobicyCrawlResult = {
  sourceUrl: string;
  platform: "jobicy";
  country: string;
  geoSlug: string | null;
  pagesScraped: number;
  totalCount: number;
  jobs: JobicyJobListingItem[];
};

export const JOBICY_API_URL = "https://jobicy.com/api/v2/remote-jobs";
export const JOBICY_LOCATIONS_URL = `${JOBICY_API_URL}?get=locations`;
export const DEFAULT_JOBICY_COUNTRY = "Argentina";
export const JOBICY_ANYWHERE_SLUG = "anywhere";
export const JOBICY_LATAM_SLUG = "latam";
/** Official max per request (docs: 1–200). */
export const JOBICY_COUNT = 200;

/**
 * Countries / slugs that should also pull Jobicy geo=latam
 * (region-wide remote roles open across Latin America).
 */
const LATAM_GEO_SLUGS = new Set([
  "latam",
  "argentina",
  "brazil",
  "mexico",
  "costa-rica",
]);

const LATAM_COUNTRY_KEYS = new Set([
  "latam",
  "latin america",
  "argentina",
  "brazil",
  "mexico",
  "costa rica",
  "chile",
  "colombia",
  "peru",
  "uruguay",
  "paraguay",
  "bolivia",
  "ecuador",
  "venezuela",
  "panama",
  "guatemala",
  "honduras",
  "el salvador",
  "nicaragua",
  "cuba",
  "dominican republic",
]);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const LOCATIONS_CACHE_TTL_MS = 60 * 60 * 1000;

export type JobicyLocation = {
  geoID?: number;
  geoName: string;
  geoSlug: string;
};

type LocationsCache = {
  fetchedAt: number;
  bySlug: Map<string, JobicyLocation>;
  byName: Map<string, JobicyLocation>;
};

let locationsCache: LocationsCache | null = null;

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "usa",
  us: "usa",
  "u.s.": "usa",
  "u.s.a.": "usa",
  "united states": "usa",
  "united states of america": "usa",
  uk: "uk",
  "u.k.": "uk",
  "united kingdom": "uk",
  "great britain": "uk",
  england: "uk",
  uae: "united-arab-emirates",
  "united arab emirates": "united-arab-emirates",
  turkey: "turkiye",
  türkiye: "turkiye",
  "south korea": "south-korea",
  "costa rica": "costa-rica",
  "new zealand": "new-zealand",
  "hong kong": "hong-kong",
  czechia: "czechia",
  "czech republic": "czechia",
};

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeKey(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeJobicyCountry(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function isValidJobicyCountry(value: string): boolean {
  const country = normalizeJobicyCountry(value);
  if (country.length < 2 || country.length > 80) return false;
  if (/^https?:\/\//i.test(country)) return false;
  return /^[\p{L}\p{M}0-9 .,'()-]+$/u.test(country);
}

export function toJobicySlugCandidate(raw: string): string {
  return normalizeKey(raw).replace(/\s+/g, "-").replace(/-+/g, "-");
}

function buildLocationsCache(locations: JobicyLocation[]): LocationsCache {
  const bySlug = new Map<string, JobicyLocation>();
  const byName = new Map<string, JobicyLocation>();

  for (const loc of locations) {
    const slug = asString(loc.geoSlug).toLowerCase();
    const name = asString(loc.geoName);
    if (!slug || !name) continue;
    const entry = { ...loc, geoSlug: slug, geoName: name };
    bySlug.set(slug, entry);
    byName.set(normalizeKey(name), entry);
  }

  for (const [alias, slug] of Object.entries(COUNTRY_ALIASES)) {
    const target = bySlug.get(slug);
    if (target) {
      byName.set(normalizeKey(alias), target);
    }
  }

  return { fetchedAt: Date.now(), bySlug, byName };
}

export async function fetchJobicyLocations(
  force = false
): Promise<LocationsCache> {
  if (
    !force &&
    locationsCache &&
    Date.now() - locationsCache.fetchedAt < LOCATIONS_CACHE_TTL_MS
  ) {
    return locationsCache;
  }

  let response: Response;
  try {
    response = await fetch(JOBICY_LOCATIONS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Devora21Backend/1.0 (+https://api.devora21.com)",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new Error(`Jobicy locations request failed: ${message}`);
  }

  if (!response.ok) {
    throw new Error(`Jobicy locations returned HTTP ${response.status}`);
  }

  const body = (await response.json()) as { locations?: unknown };
  const raw = Array.isArray(body.locations) ? body.locations : [];
  const locations: JobicyLocation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const geoSlug = asString((item as { geoSlug?: unknown }).geoSlug);
    const geoName = asString((item as { geoName?: unknown }).geoName);
    if (!geoSlug || !geoName) continue;
    locations.push({
      geoID:
        typeof (item as { geoID?: unknown }).geoID === "number"
          ? (item as { geoID: number }).geoID
          : undefined,
      geoSlug: geoSlug.toLowerCase(),
      geoName,
    });
  }

  locationsCache = buildLocationsCache(locations);
  return locationsCache;
}

/**
 * Resolve user country name to a Jobicy geoSlug when present in the taxonomy.
 * Returns null when the country is not in Jobicy's location filter (e.g. Chile).
 */
export async function resolveJobicyGeoSlug(
  countryRaw: string
): Promise<{ country: string; geoSlug: string | null; geoName: string | null }> {
  const country = normalizeJobicyCountry(countryRaw);
  const cache = await fetchJobicyLocations();

  const aliasSlug = COUNTRY_ALIASES[normalizeKey(country)];
  if (aliasSlug && cache.bySlug.has(aliasSlug)) {
    const hit = cache.bySlug.get(aliasSlug)!;
    return { country: hit.geoName, geoSlug: hit.geoSlug, geoName: hit.geoName };
  }

  const byName = cache.byName.get(normalizeKey(country));
  if (byName) {
    return {
      country: byName.geoName,
      geoSlug: byName.geoSlug,
      geoName: byName.geoName,
    };
  }

  const slugCandidate = toJobicySlugCandidate(country);
  const bySlug = cache.bySlug.get(slugCandidate);
  if (bySlug) {
    return {
      country: bySlug.geoName,
      geoSlug: bySlug.geoSlug,
      geoName: bySlug.geoName,
    };
  }

  return { country, geoSlug: null, geoName: null };
}

export function supportsJobicyCountryMode(geoSlug: string | null): boolean {
  return Boolean(geoSlug && geoSlug !== JOBICY_ANYWHERE_SLUG);
}

/** Include geo=latam for LATAM market countries (even if country slug is missing). */
export function shouldIncludeJobicyLatamGeo(
  countryRaw: string,
  geoSlug: string | null
): boolean {
  if (geoSlug && LATAM_GEO_SLUGS.has(geoSlug.toLowerCase())) {
    return true;
  }
  return LATAM_COUNTRY_KEYS.has(normalizeKey(countryRaw));
}

/**
 * Geos to query for a resolved country:
 * - country slug (when in Jobicy taxonomy, not anywhere)
 * - latam (when country is LATAM)
 * - anywhere (always)
 */
export function buildJobicyGeoList(
  countryRaw: string,
  geoSlug: string | null
): string[] {
  const geos: string[] = [];
  if (supportsJobicyCountryMode(geoSlug) && geoSlug) {
    geos.push(geoSlug);
  }
  if (shouldIncludeJobicyLatamGeo(countryRaw, geoSlug)) {
    geos.push(JOBICY_LATAM_SLUG);
  }
  geos.push(JOBICY_ANYWHERE_SLUG);
  return [...new Set(geos)];
}

export function jobicySourceKey(geoSlug: string | null, country: string): string {
  if (geoSlug) return `jobicy:${geoSlug}`;
  return `jobicy:anywhere:${normalizeJobicyCountry(country)}`;
}

/** pubDate is ISO 8601 per Jobicy docs. */
export function parseJobicyPubDateMs(pubDate: unknown): number | null {
  if (typeof pubDate === "string" && pubDate.trim()) {
    const ms = Date.parse(pubDate);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof pubDate === "number" && Number.isFinite(pubDate)) {
    return pubDate > 1e12 ? pubDate : pubDate * 1000;
  }
  return null;
}

export function isWithinLast24Hours(
  pubDate: unknown,
  nowMs = Date.now()
): boolean {
  const ms = parseJobicyPubDateMs(pubDate);
  if (ms === null) return false;
  return ms >= nowMs - ONE_DAY_MS;
}

export type JobicyApiJob = {
  id?: unknown;
  url?: unknown;
  jobSlug?: unknown;
  jobTitle?: unknown;
  companyName?: unknown;
  pubDate?: unknown;
  jobGeo?: unknown;
};

export function toAbsoluteJobicyJobUrl(url: string, jobSlug: string): string {
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
      const host = parsed.hostname.toLowerCase();
      if (host !== "jobicy.com" && !host.endsWith(".jobicy.com")) {
        return "";
      }
      parsed.protocol = "https:";
      return parsed.href;
    } catch {
      // fall through
    }
  }
  if (!jobSlug) return "";
  return `https://jobicy.com/jobs/${encodeURIComponent(jobSlug)}`;
}

export function mapJobicyApiJob(raw: JobicyApiJob): JobicyJobListingItem | null {
  const jobTitle = asString(raw.jobTitle);
  const companyName = asString(raw.companyName);
  const jobSlug = asString(raw.jobSlug);
  const url = asString(raw.url);
  const id =
    typeof raw.id === "number" && Number.isFinite(raw.id)
      ? String(raw.id)
      : jobSlug;
  const jobUrl = toAbsoluteJobicyJobUrl(url, jobSlug);
  const jobId = jobSlug || id;

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

export function buildJobicySearchUrl(geoSlug: string): string {
  const url = new URL(JOBICY_API_URL);
  url.searchParams.set("count", String(JOBICY_COUNT));
  url.searchParams.set("geo", geoSlug);
  return url.href;
}
