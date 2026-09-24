import { AppError } from "../middleware/errorHandler";
import { prisma } from "../lib/prisma";
import {
  DEFAULT_HIMALAYAS_COUNTRY,
  HIMALAYAS_MAX_PAGES,
  buildHimalayasSearchUrl,
  himalayasSourceKey,
  isValidHimalayasCountry,
  isWithinLast24Hours,
  mapHimalayasApiJob,
  normalizeHimalayasCountry,
  type HimalayasCrawlResult,
  type HimalayasJobListingItem,
} from "../lib/job-discovery/himalayas";
import { normalizeListingUrls } from "../lib/listing-urls";

type HimalayasSearchJson = {
  jobs?: unknown;
  totalCount?: unknown;
};

async function fetchHimalayasSearchPage(
  country: string,
  page: number
): Promise<HimalayasSearchJson> {
  const url = buildHimalayasSearchUrl(country, page);
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
    throw new AppError(502, `Himalayas API request failed: ${message}`);
  }

  if (response.status === 429) {
    throw new AppError(502, "Himalayas API rate limit exceeded (429). Try again later.");
  }

  if (!response.ok) {
    throw new AppError(
      502,
      `Himalayas API returned HTTP ${response.status}`
    );
  }

  try {
    return (await response.json()) as HimalayasSearchJson;
  } catch {
    throw new AppError(502, "Himalayas API returned invalid JSON");
  }
}

/**
 * Resolve country from request body, else profile listingUrls.himalayas, else Argentina.
 */
export async function resolveHimalayasCountryForUser(
  userId: string,
  requested?: { country?: string; countryName?: string }
): Promise<string> {
  const fromBody = normalizeHimalayasCountry(
    requested?.country || requested?.countryName || ""
  );
  if (fromBody) {
    if (!isValidHimalayasCountry(fromBody)) {
      throw new AppError(400, "country must be a valid country name");
    }
    return fromBody;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { listingUrls: true },
  });
  const saved = normalizeListingUrls(user?.listingUrls).himalayas?.trim() || "";
  if (saved) {
    if (!isValidHimalayasCountry(saved)) {
      throw new AppError(
        422,
        "Saved Himalayas country on your profile is invalid"
      );
    }
    return normalizeHimalayasCountry(saved);
  }

  return DEFAULT_HIMALAYAS_COUNTRY;
}

/**
 * Crawl Himalayas remote jobs for a country, posted in the last 24 hours.
 * Uses free JSON search API (no Zyte / HTML).
 */
export async function crawlHimalayasJobsByCountry(
  countryRaw: string
): Promise<HimalayasCrawlResult> {
  const country = normalizeHimalayasCountry(countryRaw);
  if (!isValidHimalayasCountry(country)) {
    throw new AppError(400, "country must be a valid country name");
  }

  const nowMs = Date.now();
  const jobs: HimalayasJobListingItem[] = [];
  const seen = new Set<string>();
  let pagesScraped = 0;

  for (let page = 1; page <= HIMALAYAS_MAX_PAGES; page += 1) {
    const data = await fetchHimalayasSearchPage(country, page);
    const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
    pagesScraped += 1;

    if (rawJobs.length === 0) {
      break;
    }

    let pageHasRecent = false;
    let pageAllOlder = true;

    for (const raw of rawJobs) {
      if (!raw || typeof raw !== "object") continue;
      const apiJob = raw as {
        title?: unknown;
        companyName?: unknown;
        applicationLink?: unknown;
        guid?: unknown;
        pubDate?: unknown;
      };

      const recent = isWithinLast24Hours(apiJob.pubDate, nowMs);
      if (recent) {
        pageHasRecent = true;
        pageAllOlder = false;
      } else {
        continue;
      }

      const mapped = mapHimalayasApiJob(apiJob);
      if (!mapped) continue;

      const dedupeKey = mapped.jobUrl || mapped.jobId;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      jobs.push(mapped);
    }

    // sort=recent → once a full page is older than 24h, stop.
    if (pageAllOlder && !pageHasRecent) {
      break;
    }

    // Short final page → no more results.
    if (rawJobs.length < 20) {
      break;
    }
  }

  return {
    sourceUrl: himalayasSourceKey(country),
    platform: "himalayas",
    pagesScraped,
    totalCount: jobs.length,
    jobs,
  };
}
