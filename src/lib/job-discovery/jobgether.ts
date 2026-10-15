/**
 * Jobgether public Jobs API — full-remote by location, newest first.
 *
 * Endpoint:
 *   GET https://jobgether.com/api/v1/jobs
 *     ?locations=<slug>
 *     &remoteType=full-remote
 *     &sort=date
 *     &limit=25
 *     &page=N
 *
 * Crawl policy: keep jobs with postedAt within the last 24 hours.
 * Stop paging when a job older than 24h appears (API is date-sorted desc)
 * or when pagination.hasMore is false.
 */

export type JobgetherJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  postedAt: string;
};

export type JobgetherCrawlResult = {
  sourceUrl: string;
  platform: "jobgether";
  country: string;
  locationSlug: string;
  pagesScraped: number;
  totalCount: number;
  jobs: JobgetherJobListingItem[];
};

export const JOBGETHER_API_URL = "https://jobgether.com/api/v1/jobs";
export const DEFAULT_JOBGETHER_COUNTRY = "Argentina";
export const JOBGETHER_PAGE_LIMIT = 25;
export const JOBGETHER_MAX_PAGES = 40;
export const JOBGETHER_REMOTE_TYPE = "full-remote";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const COUNTRY_ALIASES: Record<string, string> = {
  usa: "united-states",
  us: "united-states",
  "u.s.": "united-states",
  "u.s.a.": "united-states",
  "united states": "united-states",
  "united states of america": "united-states",
  uk: "united-kingdom",
  "u.k.": "united-kingdom",
  "united kingdom": "united-kingdom",
  "great britain": "united-kingdom",
  england: "united-kingdom",
  latam: "latin-america",
  "latin america": "latin-america",
  "costa rica": "costa-rica",
  "new zealand": "new-zealand",
  "south korea": "south-korea",
  "hong kong": "hong-kong",
  "czech republic": "czechia",
  "united arab emirates": "united-arab-emirates",
  uae: "united-arab-emirates",
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

export function normalizeJobgetherCountry(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Country name / slug → Jobgether `locations` query value. */
export function toJobgetherLocationSlug(countryRaw: string): string {
  const country = normalizeJobgetherCountry(countryRaw);
  if (!country) return "";

  const key = normalizeKey(country);
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key];

  // Already a slug
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(country.toLowerCase())) {
    return country.toLowerCase();
  }

  return key
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isValidJobgetherCountry(raw: string): boolean {
  const slug = toJobgetherLocationSlug(raw);
  return slug.length >= 2 && slug.length <= 80;
}

export function jobgetherSourceKey(locationSlug: string): string {
  return `jobgether:${locationSlug}`;
}

export function buildJobgetherSearchUrl(
  locationSlug: string,
  page: number,
  limit = JOBGETHER_PAGE_LIMIT
): string {
  const params = new URLSearchParams({
    locations: locationSlug,
    remoteType: JOBGETHER_REMOTE_TYPE,
    sort: "date",
    limit: String(limit),
    page: String(Math.max(1, page)),
  });
  return `${JOBGETHER_API_URL}?${params.toString()}`;
}

export function parseJobgetherPostedAtMs(postedAt: unknown): number | null {
  if (typeof postedAt === "string" && postedAt.trim()) {
    const ms = Date.parse(postedAt);
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof postedAt === "number" && Number.isFinite(postedAt)) {
    return postedAt > 1e12 ? postedAt : postedAt * 1000;
  }
  return null;
}

/** postedAt must be within the last 24 hours (inclusive of the cutoff). */
export function isWithinLast24Hours(
  postedAt: unknown,
  nowMs = Date.now()
): boolean {
  const ms = parseJobgetherPostedAtMs(postedAt);
  if (ms === null) return false;
  return ms >= nowMs - ONE_DAY_MS;
}

export type JobgetherApiJob = {
  id?: unknown;
  title?: unknown;
  company?: unknown;
  url?: unknown;
  location?: unknown;
  remote?: unknown;
  postedAt?: unknown;
};

export function mapJobgetherApiJob(
  job: JobgetherApiJob
): JobgetherJobListingItem | null {
  const jobId = asString(job.id);
  const jobTitle = asString(job.title);
  const companyName = asString(job.company);
  let jobUrl = asString(job.url);
  const postedAtMs = parseJobgetherPostedAtMs(job.postedAt);

  if (!jobId || !jobTitle || !companyName || postedAtMs === null) {
    return null;
  }

  if (!jobUrl) {
    jobUrl = `https://jobgether.com/offer/${encodeURIComponent(jobId)}`;
  } else {
    try {
      const parsed = new URL(jobUrl);
      const host = parsed.hostname.toLowerCase();
      if (host !== "jobgether.com" && !host.endsWith(".jobgether.com")) {
        jobUrl = `https://jobgether.com/offer/${encodeURIComponent(jobId)}`;
      }
    } catch {
      jobUrl = `https://jobgether.com/offer/${encodeURIComponent(jobId)}`;
    }
  }

  return {
    jobId,
    companyName,
    jobTitle,
    jobUrl,
    postedAt: new Date(postedAtMs).toISOString(),
  };
}
