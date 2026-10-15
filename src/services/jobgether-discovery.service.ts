import { AppError } from "../middleware/errorHandler";
import { prisma } from "../lib/prisma";
import {
  DEFAULT_JOBGETHER_COUNTRY,
  JOBGETHER_MAX_PAGES,
  JOBGETHER_PAGE_LIMIT,
  buildJobgetherSearchUrl,
  isValidJobgetherCountry,
  isWithinLast24Hours,
  jobgetherSourceKey,
  mapJobgetherApiJob,
  normalizeJobgetherCountry,
  toJobgetherLocationSlug,
  type JobgetherApiJob,
  type JobgetherCrawlResult,
  type JobgetherJobListingItem,
} from "../lib/job-discovery/jobgether";
import { normalizeListingUrls } from "../lib/listing-urls";

type JobgetherSearchJson = {
  jobs?: unknown;
  pagination?: {
    page?: unknown;
    limit?: unknown;
    hasMore?: unknown;
  };
  message?: unknown;
  error?: unknown;
};

async function fetchJobgetherPage(
  locationSlug: string,
  page: number
): Promise<JobgetherSearchJson> {
  const url = buildJobgetherSearchUrl(locationSlug, page, JOBGETHER_PAGE_LIMIT);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Devora21Backend/1.0 (+https://api.devora21.com)",
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new AppError(502, `Jobgether API request failed: ${message}`);
  }

  if (response.status === 429) {
    throw new AppError(
      502,
      "Jobgether API rate limit exceeded (429). Try again later."
    );
  }

  let body: JobgetherSearchJson = {};
  try {
    body = (await response.json()) as JobgetherSearchJson;
  } catch {
    if (!response.ok) {
      throw new AppError(502, `Jobgether API returned HTTP ${response.status}`);
    }
    throw new AppError(502, "Jobgether API returned invalid JSON");
  }

  if (!response.ok) {
    const apiMessage =
      (typeof body.message === "string" && body.message.trim()) ||
      (typeof body.error === "string" && body.error.trim()) ||
      `Jobgether API returned HTTP ${response.status}`;
    throw new AppError(response.status === 422 ? 400 : 502, apiMessage);
  }

  return body;
}

/**
 * Resolve country from request body, else profile listingUrls.jobgether, else Argentina.
 */
export async function resolveJobgetherCountryForUser(
  userId: string,
  requested?: { country?: string; countryName?: string }
): Promise<string> {
  const fromBody = normalizeJobgetherCountry(
    requested?.country || requested?.countryName || ""
  );
  if (fromBody) {
    if (!isValidJobgetherCountry(fromBody)) {
      throw new AppError(400, "country must be a valid country name");
    }
    return fromBody;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { listingUrls: true },
  });
  const saved = normalizeListingUrls(user?.listingUrls).jobgether?.trim() || "";
  if (saved) {
    if (!isValidJobgetherCountry(saved)) {
      throw new AppError(
        422,
        "Saved Jobgether country on your profile is invalid"
      );
    }
    return normalizeJobgetherCountry(saved);
  }

  return DEFAULT_JOBGETHER_COUNTRY;
}

/**
 * Crawl Jobgether full-remote jobs for a location (newest first).
 *
 * Pagination:
 * - page starts at 1, limit 25, sort=date
 * - keep jobs with postedAt within last 24 hours
 * - stop when a job older than 24h appears OR hasMore is false
 */
export async function crawlJobgetherJobsByCountry(
  countryRaw: string
): Promise<JobgetherCrawlResult> {
  const country = normalizeJobgetherCountry(countryRaw);
  if (!isValidJobgetherCountry(country)) {
    throw new AppError(400, "country must be a valid country name");
  }

  const locationSlug = toJobgetherLocationSlug(country);
  if (!locationSlug) {
    throw new AppError(400, "country must be a valid country name");
  }

  const nowMs = Date.now();
  const jobs: JobgetherJobListingItem[] = [];
  const seen = new Set<string>();
  let pagesScraped = 0;
  let stopBecauseOld = false;

  for (let page = 1; page <= JOBGETHER_MAX_PAGES; page += 1) {
    const data = await fetchJobgetherPage(locationSlug, page);
    pagesScraped += 1;

    const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
    if (rawJobs.length === 0) {
      break;
    }

    let pageHadRecent = false;
    for (const raw of rawJobs) {
      if (!raw || typeof raw !== "object") continue;
      const apiJob = raw as JobgetherApiJob;

      if (!isWithinLast24Hours(apiJob.postedAt, nowMs)) {
        // API is sorted by date desc — older jobs mean stop paging.
        stopBecauseOld = true;
        break;
      }

      pageHadRecent = true;
      const mapped = mapJobgetherApiJob(apiJob);
      if (!mapped) continue;

      const dedupeKey = mapped.jobUrl || mapped.jobId;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      jobs.push(mapped);
    }

    if (stopBecauseOld) {
      break;
    }

    const hasMore = data.pagination?.hasMore === true;
    if (!hasMore || !pageHadRecent) {
      break;
    }
  }

  return {
    sourceUrl: jobgetherSourceKey(locationSlug),
    platform: "jobgether",
    country,
    locationSlug,
    pagesScraped,
    totalCount: jobs.length,
    jobs,
  };
}
