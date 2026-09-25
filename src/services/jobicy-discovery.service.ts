import { AppError } from "../middleware/errorHandler";
import { prisma } from "../lib/prisma";
import {
  DEFAULT_JOBICY_COUNTRY,
  buildJobicyGeoList,
  buildJobicySearchUrl,
  isValidJobicyCountry,
  isWithinLast24Hours,
  jobicySourceKey,
  mapJobicyApiJob,
  normalizeJobicyCountry,
  resolveJobicyGeoSlug,
  type JobicyApiJob,
  type JobicyCrawlResult,
  type JobicyJobListingItem,
} from "../lib/job-discovery/jobicy";
import { normalizeListingUrls } from "../lib/listing-urls";

type JobicySearchJson = {
  jobs?: unknown;
  jobCount?: unknown;
  message?: unknown;
};

async function fetchJobicySearchPage(geoSlug: string): Promise<JobicySearchJson> {
  const url = buildJobicySearchUrl(geoSlug);
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
    throw new AppError(502, `Jobicy API request failed: ${message}`);
  }

  if (response.status === 429) {
    throw new AppError(
      502,
      "Jobicy API rate limit exceeded (429). Try again later."
    );
  }

  let body: JobicySearchJson = {};
  try {
    body = (await response.json()) as JobicySearchJson;
  } catch {
    if (!response.ok) {
      throw new AppError(502, `Jobicy API returned HTTP ${response.status}`);
    }
    throw new AppError(502, "Jobicy API returned invalid JSON");
  }

  if (!response.ok) {
    const apiMessage =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : `Jobicy API returned HTTP ${response.status}`;
    throw new AppError(response.status === 422 ? 400 : 502, apiMessage);
  }

  return body;
}

function collectRecentJobs(
  rawJobs: unknown[],
  nowMs: number,
  seen: Set<string>,
  out: JobicyJobListingItem[]
): void {
  for (const raw of rawJobs) {
    if (!raw || typeof raw !== "object") continue;
    const apiJob = raw as JobicyApiJob;
    if (!isWithinLast24Hours(apiJob.pubDate, nowMs)) continue;

    const mapped = mapJobicyApiJob(apiJob);
    if (!mapped) continue;

    const dedupeKey = mapped.jobUrl || mapped.jobId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push(mapped);
  }
}

/**
 * Resolve country from request body, else profile listingUrls.jobicy, else Argentina.
 */
export async function resolveJobicyCountryForUser(
  userId: string,
  requested?: { country?: string; countryName?: string }
): Promise<string> {
  const fromBody = normalizeJobicyCountry(
    requested?.country || requested?.countryName || ""
  );
  if (fromBody) {
    if (!isValidJobicyCountry(fromBody)) {
      throw new AppError(400, "country must be a valid country name");
    }
    return fromBody;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { listingUrls: true },
  });
  const saved = normalizeListingUrls(user?.listingUrls).jobicy?.trim() || "";
  if (saved) {
    if (!isValidJobicyCountry(saved)) {
      throw new AppError(422, "Saved Jobicy country on your profile is invalid");
    }
    return normalizeJobicyCountry(saved);
  }

  return DEFAULT_JOBICY_COUNTRY;
}

/**
 * Crawl Jobicy remote jobs (free public API).
 *
 * Geos queried (deduped):
 * - geo=<country slug> when country is in Jobicy taxonomy
 * - geo=latam when country is a LATAM market
 * - geo=anywhere always
 * Keep jobs with pubDate in the last 24 hours.
 */
export async function crawlJobicyJobsByCountry(
  countryRaw: string
): Promise<JobicyCrawlResult> {
  const countryInput = normalizeJobicyCountry(countryRaw);
  if (!isValidJobicyCountry(countryInput)) {
    throw new AppError(400, "country must be a valid country name");
  }

  let resolved;
  try {
    resolved = await resolveJobicyGeoSlug(countryInput);
  } catch (err) {
    const message = err instanceof Error ? err.message : "taxonomy error";
    throw new AppError(502, message);
  }

  const nowMs = Date.now();
  const jobs: JobicyJobListingItem[] = [];
  const seen = new Set<string>();
  let pagesScraped = 0;

  const uniqueGeos = buildJobicyGeoList(resolved.country, resolved.geoSlug);

  const results = await Promise.all(
    uniqueGeos.map(async (geo) => {
      const data = await fetchJobicySearchPage(geo);
      return data;
    })
  );

  for (const data of results) {
    pagesScraped += 1;
    const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
    collectRecentJobs(rawJobs, nowMs, seen, jobs);
  }

  return {
    sourceUrl: jobicySourceKey(resolved.geoSlug, resolved.country),
    platform: "jobicy",
    country: resolved.geoName || resolved.country,
    geoSlug: resolved.geoSlug,
    pagesScraped,
    totalCount: jobs.length,
    jobs,
  };
}
