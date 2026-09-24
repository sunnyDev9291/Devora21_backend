import { AppError } from "../middleware/errorHandler";
import { prisma } from "../lib/prisma";
import {
  DEFAULT_GETONBOARD_COUNTRY,
  GETONBOARD_MAX_PAGES,
  GETONBOARD_PER_PAGE,
  buildGetOnBoardSearchUrl,
  countryDisplayNameForCode,
  getonboardSourceKey,
  isGetOnBoardRemoteJob,
  isValidGetOnBoardCountry,
  isWithinLast24Hours,
  mapGetOnBoardApiJob,
  normalizeGetOnBoardCountry,
  resolveGetOnBoardCountryCode,
  supportsGetOnBoardCountryMode,
  type GetOnBoardApiJob,
  type GetOnBoardCrawlResult,
  type GetOnBoardJobListingItem,
  type GetOnBoardSearchMode,
} from "../lib/job-discovery/getonboard";
import { normalizeListingUrls } from "../lib/listing-urls";

type GetOnBoardSearchJson = {
  data?: unknown;
  meta?: {
    page?: unknown;
    per_page?: unknown;
    total_pages?: unknown;
  };
  message?: unknown;
  code?: unknown;
};

type ModeCrawlSlice = {
  pagesScraped: number;
  jobs: GetOnBoardJobListingItem[];
};

async function fetchGetOnBoardSearchPage(
  mode: GetOnBoardSearchMode,
  page: number,
  countryCode?: string
): Promise<GetOnBoardSearchJson> {
  const url = buildGetOnBoardSearchUrl(mode, page, countryCode);
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
    throw new AppError(502, `Get on Board API request failed: ${message}`);
  }

  if (response.status === 429) {
    throw new AppError(
      502,
      "Get on Board API rate limit exceeded (429). Try again later."
    );
  }

  let body: GetOnBoardSearchJson = {};
  try {
    body = (await response.json()) as GetOnBoardSearchJson;
  } catch {
    if (!response.ok) {
      throw new AppError(
        502,
        `Get on Board API returned HTTP ${response.status}`
      );
    }
    throw new AppError(502, "Get on Board API returned invalid JSON");
  }

  if (!response.ok) {
    const apiMessage =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : `Get on Board API returned HTTP ${response.status}`;
    throw new AppError(response.status === 422 ? 400 : 502, apiMessage);
  }

  return body;
}

/**
 * Paginate one Search API mode and keep remote jobs from the last 24 hours.
 * Mode "country": country_code only, then remote filter client-side.
 * Mode "remote": remote=true only (any location / worldwide).
 */
async function crawlGetOnBoardMode(
  mode: GetOnBoardSearchMode,
  nowMs: number,
  countryCode?: string
): Promise<ModeCrawlSlice> {
  const jobs: GetOnBoardJobListingItem[] = [];
  const seen = new Set<string>();
  let pagesScraped = 0;
  let totalPages = GETONBOARD_MAX_PAGES;

  for (let page = 1; page <= GETONBOARD_MAX_PAGES; page += 1) {
    if (page > totalPages) break;

    const data = await fetchGetOnBoardSearchPage(mode, page, countryCode);
    const rawJobs = Array.isArray(data.data) ? data.data : [];
    pagesScraped += 1;

    const metaTotal = data.meta?.total_pages;
    if (
      typeof metaTotal === "number" &&
      Number.isFinite(metaTotal) &&
      metaTotal > 0
    ) {
      totalPages = Math.min(GETONBOARD_MAX_PAGES, Math.floor(metaTotal));
    }

    if (rawJobs.length === 0) {
      break;
    }

    for (const raw of rawJobs) {
      if (!raw || typeof raw !== "object") continue;
      const apiJob = raw as GetOnBoardApiJob;
      const attributes =
        apiJob.attributes && typeof apiJob.attributes === "object"
          ? apiJob.attributes
          : {};

      // Country mode returns hybrid/onsite too — keep remotes only.
      // Remote mode is already remote=true from the API.
      if (!isGetOnBoardRemoteJob(attributes)) continue;
      if (!isWithinLast24Hours(attributes.published_at, nowMs)) continue;

      const mapped = mapGetOnBoardApiJob(apiJob);
      if (!mapped) continue;

      const dedupeKey = mapped.jobUrl || mapped.jobId;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      jobs.push(mapped);
    }

    if (rawJobs.length < GETONBOARD_PER_PAGE) {
      break;
    }
  }

  return { pagesScraped, jobs };
}

/**
 * Resolve country from request body, else profile listingUrls.getonboard, else Argentina.
 */
export async function resolveGetOnBoardCountryForUser(
  userId: string,
  requested?: { country?: string; countryName?: string }
): Promise<string> {
  const fromBody = normalizeGetOnBoardCountry(
    requested?.country || requested?.countryName || ""
  );
  if (fromBody) {
    if (!isValidGetOnBoardCountry(fromBody)) {
      throw new AppError(400, "country must be a valid country name");
    }
    if (!resolveGetOnBoardCountryCode(fromBody)) {
      throw new AppError(
        400,
        `Unknown country "${fromBody}" (use a country name or ISO alpha-2 code like AR)`
      );
    }
    return fromBody;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { listingUrls: true },
  });
  const saved =
    normalizeListingUrls(user?.listingUrls).getonboard?.trim() || "";
  if (saved) {
    if (
      !isValidGetOnBoardCountry(saved) ||
      !resolveGetOnBoardCountryCode(saved)
    ) {
      throw new AppError(
        422,
        "Saved Get on Board country on your profile is invalid"
      );
    }
    return normalizeGetOnBoardCountry(saved);
  }

  return DEFAULT_GETONBOARD_COUNTRY;
}

/**
 * Crawl Get on Board with official Search modes, then merge:
 * - If country is in Get on Board's location filter (AR/CL/CO/MX/PE):
 *   1) country_code=<user country> → remotes in that market (last 24h)
 *   2) remote=true → Remote (Any location) worldwide (last 24h)
 * - Else (e.g. Brazil — no UI country filter): mode 2 only.
 *
 * API forbids combining country_code + remote in one request; docs say make two requests.
 */
export async function crawlGetOnBoardJobsByCountry(
  countryRaw: string
): Promise<GetOnBoardCrawlResult> {
  const country = normalizeGetOnBoardCountry(countryRaw);
  if (!isValidGetOnBoardCountry(country)) {
    throw new AppError(400, "country must be a valid country name");
  }

  const countryCode = resolveGetOnBoardCountryCode(country);
  if (!countryCode) {
    throw new AppError(
      400,
      `Unknown country "${country}" (use a country name or ISO alpha-2 code like AR)`
    );
  }

  const nowMs = Date.now();
  const useCountryMode = supportsGetOnBoardCountryMode(countryCode);

  const [countrySlice, remoteSlice] = await Promise.all([
    useCountryMode
      ? crawlGetOnBoardMode("country", nowMs, countryCode)
      : Promise.resolve({ pagesScraped: 0, jobs: [] as GetOnBoardJobListingItem[] }),
    crawlGetOnBoardMode("remote", nowMs),
  ]);

  const jobs: GetOnBoardJobListingItem[] = [];
  const seen = new Set<string>();

  for (const job of [...countrySlice.jobs, ...remoteSlice.jobs]) {
    const dedupeKey = job.jobUrl || job.jobId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    jobs.push(job);
  }

  return {
    sourceUrl: getonboardSourceKey(countryCode),
    platform: "getonboard",
    country: countryDisplayNameForCode(countryCode),
    countryCode,
    pagesScraped: countrySlice.pagesScraped + remoteSlice.pagesScraped,
    totalCount: jobs.length,
    jobs,
  };
}
