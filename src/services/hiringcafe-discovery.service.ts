import { AppError } from "../middleware/errorHandler";
import { fetchZyteBrowserHtml } from "../lib/zyte-client";
import {
  buildHiringCafeListingPageUrl,
  DEFAULT_HIRINGCAFE_CRAWL_URL,
  extractHiringCafeLastPageNumber,
  normalizeHiringCafeMainListingUrl,
  parseHiringCafeListingHtml,
  type HiringCafeCrawlResult,
  type HiringCafeListingParseResult,
} from "../lib/job-discovery/hiringcafe-parse";

const MAX_HIRINGCAFE_CRAWL_PAGES = 50;

export function isHiringCafeListingUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "hiringcafe.com" || host.endsWith(".hiringcafe.com");
  } catch {
    return false;
  }
}

async function fetchHiringCafeListingHtml(targetUrl: string): Promise<{
  html: string;
  pageUrl: string;
}> {
  return fetchZyteBrowserHtml(
    targetUrl,
    "Zyte returned an empty HiringCafe listing page"
  );
}

export async function discoverHiringCafeJobsFromUrl(
  listingUrl: string
): Promise<HiringCafeListingParseResult> {
  const targetUrl = listingUrl.trim();
  if (!isHiringCafeListingUrl(targetUrl)) {
    throw new AppError(400, "url must be a HiringCafe search listing page");
  }

  const { html, pageUrl } = await fetchHiringCafeListingHtml(targetUrl);
  const parsed = parseHiringCafeListingHtml(html, pageUrl);

  if (parsed.totalCount === 0) {
    throw new AppError(
      422,
      "No jobs found on the HiringCafe listing page. The page layout may have changed."
    );
  }

  return parsed;
}

/**
 * Crawl all HiringCafe listing pages via Zyte (page 0 main URL → last page).
 * Merges and dedupes jobs by jobId.
 */
export async function crawlHiringCafeJobsFromUrl(
  listingUrl: string
): Promise<HiringCafeCrawlResult> {
  const mainUrl = normalizeHiringCafeMainListingUrl(listingUrl);
  if (!isHiringCafeListingUrl(mainUrl)) {
    throw new AppError(400, "url must be a HiringCafe search listing page");
  }

  const jobsById = new Map<
    string,
    HiringCafeCrawlResult["jobs"][number]
  >();
  let lastPage = 0;
  let pagesScraped = 0;

  for (let page = 0; page <= lastPage; page += 1) {
    if (page >= MAX_HIRINGCAFE_CRAWL_PAGES) {
      break;
    }

    const pageUrl = buildHiringCafeListingPageUrl(mainUrl, page);
    const { html } = await fetchHiringCafeListingHtml(pageUrl);
    const parsed = parseHiringCafeListingHtml(html, pageUrl);

    if (page === 0) {
      lastPage = Math.min(
        extractHiringCafeLastPageNumber(html),
        MAX_HIRINGCAFE_CRAWL_PAGES - 1
      );
    }

    if (parsed.jobs.length === 0 && page > 0) {
      break;
    }

    pagesScraped += 1;

    for (const job of parsed.jobs) {
      jobsById.set(job.jobId, job);
    }
  }

  const jobs = [...jobsById.values()];
  if (jobs.length === 0) {
    throw new AppError(
      422,
      "No jobs found on the HiringCafe listing. The page layout may have changed."
    );
  }

  return {
    sourceUrl: mainUrl,
    platform: "hiringcafe",
    pagesScraped,
    totalCount: jobs.length,
    jobs,
  };
}

/** Parse saved/local HTML (for tests or admin tooling). */
export function discoverHiringCafeJobsFromHtml(
  html: string,
  sourceUrl?: string
): HiringCafeListingParseResult {
  return parseHiringCafeListingHtml(html, sourceUrl);
}

export { DEFAULT_HIRINGCAFE_CRAWL_URL };
