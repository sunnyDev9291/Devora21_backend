export type WorkableJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type WorkableListingParseResult = {
  sourceUrl?: string;
  platform: "workable";
  totalCount: number;
  jobs: WorkableJobListingItem[];
};

export type WorkableCrawlResult = {
  sourceUrl: string;
  platform: "workable";
  pagesScraped: number;
  totalCount: number;
  jobs: WorkableJobListingItem[];
};

const WORKABLE_ORIGIN = "https://jobs.workable.com";

/** Argentina remote, posted last 24 hours (single-page listing). */
export const DEFAULT_WORKABLE_CRAWL_URL =
  "https://jobs.workable.com/search?location=Argentina&day_range=1&workplace=remote";

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function toAbsoluteWorkableUrl(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, WORKABLE_ORIGIN).href;
  } catch {
    return pathOrUrl;
  }
}

function jobIdFromViewPath(path: string): string {
  const match = path.match(/^\/view\/([^/]+)\//);
  return match?.[1] ?? "";
}

/**
 * Each listing row is a `data-ui="job-item"` block with company/title attrs
 * and a `/view/{shortcode}/...` job URL.
 */
function extractWorkableJobItems(html: string): WorkableJobListingItem[] {
  const jobs: WorkableJobListingItem[] = [];
  const seenJobIds = new Set<string>();

  const jobItemPattern =
    /data-company-name="([^"]*)"[^>]*data-job-title="([^"]*)"[^>]*data-ui="job-item"[\s\S]*?href="(\/view\/[^"]+)"/gi;

  for (const match of html.matchAll(jobItemPattern)) {
    const companyName = decodeHtmlEntities(match[1]);
    const jobTitle = decodeHtmlEntities(match[2]);
    const viewPath = match[3];
    const jobId = jobIdFromViewPath(viewPath);

    if (!jobId || !jobTitle || seenJobIds.has(jobId)) {
      continue;
    }

    seenJobIds.add(jobId);
    jobs.push({
      jobId,
      companyName,
      jobTitle,
      jobUrl: toAbsoluteWorkableUrl(viewPath),
    });
  }

  if (jobs.length > 0) {
    return jobs;
  }

  // Fallback: overlay aria-label + view link
  const fallbackPattern =
    /aria-label="([^"]+ at [^"]+)"[^>]*href="(\/view\/[^"]+)"/gi;

  for (const match of html.matchAll(fallbackPattern)) {
    const label = decodeHtmlEntities(match[1]);
    const viewPath = match[2];
    const jobId = jobIdFromViewPath(viewPath);
    if (!jobId || seenJobIds.has(jobId)) {
      continue;
    }

    const atIndex = label.lastIndexOf(" at ");
    const jobTitle = atIndex === -1 ? label : label.slice(0, atIndex);
    const companyName = atIndex === -1 ? "" : label.slice(atIndex + 4);

    if (!jobTitle) {
      continue;
    }

    seenJobIds.add(jobId);
    jobs.push({
      jobId,
      companyName,
      jobTitle,
      jobUrl: toAbsoluteWorkableUrl(viewPath),
    });
  }

  return jobs;
}

export function parseWorkableListingHtml(
  html: string,
  sourceUrl?: string
): WorkableListingParseResult {
  const jobs = extractWorkableJobItems(html);

  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    platform: "workable",
    totalCount: jobs.length,
    jobs,
  };
}

export function normalizeWorkableListingUrl(listingUrl: string): string {
  return listingUrl.trim();
}
