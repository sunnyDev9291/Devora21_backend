import { AppError } from "../middleware/errorHandler";
import { fetchZyteBrowserHtml } from "../lib/zyte-client";
import {
  DEFAULT_WORKABLE_CRAWL_URL,
  normalizeWorkableListingUrl,
  parseWorkableListingHtml,
  type WorkableCrawlResult,
  type WorkableListingParseResult,
} from "../lib/job-discovery/workable-parse";

export function isWorkableListingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "jobs.workable.com" || host.endsWith(".jobs.workable.com")) &&
      parsed.pathname.startsWith("/search")
    );
  } catch {
    return false;
  }
}

async function fetchWorkableListingHtml(targetUrl: string): Promise<{
  html: string;
  pageUrl: string;
}> {
  return fetchZyteBrowserHtml(
    targetUrl,
    "Zyte returned an empty Workable listing page"
  );
}

export async function discoverWorkableJobsFromUrl(
  listingUrl: string
): Promise<WorkableListingParseResult> {
  const targetUrl = normalizeWorkableListingUrl(listingUrl);
  if (!isWorkableListingUrl(targetUrl)) {
    throw new AppError(
      400,
      "url must be a Workable jobs search listing page (jobs.workable.com/search)"
    );
  }

  const { html, pageUrl } = await fetchWorkableListingHtml(targetUrl);
  const parsed = parseWorkableListingHtml(html, pageUrl);

  if (parsed.totalCount === 0) {
    throw new AppError(
      422,
      "No jobs found on the Workable listing page. The page layout may have changed."
    );
  }

  return parsed;
}

/** Workable search listings are single-page — crawl equals discover. */
export async function crawlWorkableJobsFromUrl(
  listingUrl: string
): Promise<WorkableCrawlResult> {
  const mainUrl = normalizeWorkableListingUrl(listingUrl);
  const parsed = await discoverWorkableJobsFromUrl(mainUrl);

  return {
    sourceUrl: mainUrl,
    platform: "workable",
    pagesScraped: 1,
    totalCount: parsed.jobs.length,
    jobs: parsed.jobs,
  };
}

export function discoverWorkableJobsFromHtml(
  html: string,
  sourceUrl?: string
): WorkableListingParseResult {
  return parseWorkableListingHtml(html, sourceUrl);
}

export { DEFAULT_WORKABLE_CRAWL_URL };
