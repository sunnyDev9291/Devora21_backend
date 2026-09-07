import { AppError } from "../middleware/errorHandler";
import { fetchZyteBrowserHtml } from "../lib/zyte-client";
import {
  DEFAULT_WORKINGNOMADS_CRAWL_URL,
  normalizeWorkingNomadsListingUrl,
  parseWorkingNomadsListingHtml,
  type WorkingNomadsCrawlResult,
  type WorkingNomadsListingParseResult,
} from "../lib/job-discovery/workingnomads-parse";

export function isWorkingNomadsListingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "workingnomads.com" || host.endsWith(".workingnomads.com")) &&
      parsed.pathname === "/jobs"
    );
  } catch {
    return false;
  }
}

async function fetchWorkingNomadsListingHtml(targetUrl: string): Promise<{
  html: string;
  pageUrl: string;
}> {
  return fetchZyteBrowserHtml(
    targetUrl,
    "Zyte returned an empty Working Nomads listing page"
  );
}

export async function discoverWorkingNomadsJobsFromUrl(
  listingUrl: string
): Promise<WorkingNomadsListingParseResult> {
  const targetUrl = normalizeWorkingNomadsListingUrl(listingUrl);
  if (!isWorkingNomadsListingUrl(targetUrl)) {
    throw new AppError(
      400,
      "url must be a Working Nomads jobs listing page (workingnomads.com/jobs)"
    );
  }

  const { html, pageUrl } = await fetchWorkingNomadsListingHtml(targetUrl);
  const parsed = parseWorkingNomadsListingHtml(html, pageUrl);

  if (parsed.totalCount === 0) {
    throw new AppError(
      422,
      "No jobs found on the Working Nomads listing page. The page layout may have changed."
    );
  }

  return parsed;
}

/** Working Nomads listings are single-page — crawl equals discover. */
export async function crawlWorkingNomadsJobsFromUrl(
  listingUrl: string
): Promise<WorkingNomadsCrawlResult> {
  const mainUrl = normalizeWorkingNomadsListingUrl(listingUrl);
  const parsed = await discoverWorkingNomadsJobsFromUrl(mainUrl);

  return {
    sourceUrl: mainUrl,
    platform: "workingnomads",
    pagesScraped: 1,
    totalCount: parsed.jobs.length,
    jobs: parsed.jobs,
  };
}

export function discoverWorkingNomadsJobsFromHtml(
  html: string,
  sourceUrl?: string
): WorkingNomadsListingParseResult {
  return parseWorkingNomadsListingHtml(html, sourceUrl);
}

export { DEFAULT_WORKINGNOMADS_CRAWL_URL };
