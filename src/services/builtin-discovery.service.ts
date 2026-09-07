import { AppError } from "../middleware/errorHandler";
import { fetchZyteBrowserHtml } from "../lib/zyte-client";
import {
  buildBuiltInListingPageUrl,
  DEFAULT_BUILTIN_CRAWL_URL,
  extractBuiltInLastPageNumber,
  normalizeBuiltInMainListingUrl,
  parseBuiltInListingHtml,
  type BuiltInCrawlResult,
  type BuiltInListingParseResult,
} from "../lib/job-discovery/builtin-parse";

const MAX_BUILTIN_CRAWL_PAGES = 50;

export function isBuiltInListingUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "builtin.com" || host.endsWith(".builtin.com");
  } catch {
    return false;
  }
}

async function fetchBuiltInListingHtml(targetUrl: string): Promise<{
  html: string;
  pageUrl: string;
}> {
  return fetchZyteBrowserHtml(
    targetUrl,
    "Zyte returned an empty Built In listing page"
  );
}

export async function discoverBuiltInJobsFromUrl(
  listingUrl: string
): Promise<BuiltInListingParseResult> {
  const targetUrl = listingUrl.trim();
  if (!isBuiltInListingUrl(targetUrl)) {
    throw new AppError(400, "url must be a Built In jobs listing page");
  }

  const { html, pageUrl } = await fetchBuiltInListingHtml(targetUrl);
  const parsed = parseBuiltInListingHtml(html, pageUrl);

  if (parsed.totalCount === 0) {
    throw new AppError(
      422,
      "No jobs found on the Built In listing page. The page layout may have changed."
    );
  }

  return parsed;
}

/**
 * Crawl all Built In listing pages via Zyte (page 1 main URL → last page).
 * Merges and dedupes jobs by jobId.
 */
export async function crawlBuiltInJobsFromUrl(
  listingUrl: string
): Promise<BuiltInCrawlResult> {
  const mainUrl = normalizeBuiltInMainListingUrl(listingUrl);
  if (!isBuiltInListingUrl(mainUrl)) {
    throw new AppError(400, "url must be a Built In jobs listing page");
  }

  const jobsById = new Map<
    string,
    BuiltInCrawlResult["jobs"][number]
  >();
  let lastPage = 1;
  let pagesScraped = 0;

  for (let page = 1; page <= lastPage; page += 1) {
    if (page > MAX_BUILTIN_CRAWL_PAGES) {
      break;
    }

    const pageUrl = buildBuiltInListingPageUrl(mainUrl, page);
    const { html } = await fetchBuiltInListingHtml(pageUrl);
    const parsed = parseBuiltInListingHtml(html, pageUrl);

    if (page === 1) {
      lastPage = Math.min(
        extractBuiltInLastPageNumber(html),
        MAX_BUILTIN_CRAWL_PAGES
      );
    }

    if (parsed.jobs.length === 0 && page > 1) {
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
      "No jobs found on the Built In listing. The page layout may have changed."
    );
  }

  return {
    sourceUrl: mainUrl,
    platform: "builtin",
    pagesScraped,
    totalCount: jobs.length,
    jobs,
  };
}

/** Parse saved/local HTML (for tests or admin tooling). */
export function discoverBuiltInJobsFromHtml(
  html: string,
  sourceUrl?: string
): BuiltInListingParseResult {
  return parseBuiltInListingHtml(html, sourceUrl);
}

export { DEFAULT_BUILTIN_CRAWL_URL };
