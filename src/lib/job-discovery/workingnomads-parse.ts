export type WorkingNomadsJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type WorkingNomadsListingParseResult = {
  sourceUrl?: string;
  platform: "workingnomads";
  totalCount: number;
  jobs: WorkingNomadsJobListingItem[];
};

export type WorkingNomadsCrawlResult = {
  sourceUrl: string;
  platform: "workingnomads";
  pagesScraped: number;
  totalCount: number;
  jobs: WorkingNomadsJobListingItem[];
};

const WORKINGNOMADS_ORIGIN = "https://www.workingnomads.com";

/** Development jobs in Argentina, posted last 24 hours (single-page listing). */
export const DEFAULT_WORKINGNOMADS_CRAWL_URL =
  "https://www.workingnomads.com/jobs?category=development&location=argentina&postedDate=1";

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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toAbsoluteWorkingNomadsUrl(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, WORKINGNOMADS_ORIGIN).href;
  } catch {
    return pathOrUrl;
  }
}

function resolveJobTitle(block: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(
      block.match(/<h4[^>]*>\s*([\s\S]*?)<\/h4>/i)?.[1] ||
        block.match(/job-desktop__title[^>]*>([^<]+)/i)?.[1] ||
        ""
    )
  );
}

function resolveCompanyName(block: string): string {
  return normalizeWhitespace(
    decodeHtmlEntities(
      block.match(/job-desktop__company[^>]*>\s*([^<]+)/i)?.[1] ||
        block.match(/class="[^"]*company[^"]*"[^>]*>\s*([^<]+)/i)?.[1] ||
        ""
    )
  );
}

/**
 * Each listing card is an `<a class="job-desktop" id="job-{id}" href="/jobs/...">`.
 */
function extractWorkingNomadsJobItems(
  html: string
): WorkingNomadsJobListingItem[] {
  const jobs: WorkingNomadsJobListingItem[] = [];
  const seenJobIds = new Set<string>();

  const cardPattern =
    /<a[^>]*id="job-(\d+)"[^>]*class="[^"]*job-desktop[^"]*"[^>]*href="(\/jobs\/[^"]+)"[\s\S]*?<\/a>/gi;

  for (const match of html.matchAll(cardPattern)) {
    const block = match[0];
    const jobId = match[1];
    const jobPath = match[2];
    const jobTitle = resolveJobTitle(block);

    if (!jobId || !jobTitle || seenJobIds.has(jobId)) {
      continue;
    }

    seenJobIds.add(jobId);
    jobs.push({
      jobId,
      companyName: resolveCompanyName(block),
      jobTitle,
      jobUrl: toAbsoluteWorkingNomadsUrl(jobPath),
    });
  }

  if (jobs.length > 0) {
    return jobs;
  }

  // Fallback: id + href + nearby h4
  const fallbackPattern =
    /id="job-(\d+)"[^>]*href="(\/jobs\/[^"]+)"[\s\S]{0,2500}?<h4[^>]*>\s*([\s\S]*?)<\/h4>/gi;

  for (const match of html.matchAll(fallbackPattern)) {
    const jobId = match[1];
    const jobPath = match[2];
    const jobTitle = normalizeWhitespace(decodeHtmlEntities(match[3]));

    if (!jobId || !jobTitle || seenJobIds.has(jobId)) {
      continue;
    }

    seenJobIds.add(jobId);
    jobs.push({
      jobId,
      companyName: "",
      jobTitle,
      jobUrl: toAbsoluteWorkingNomadsUrl(jobPath),
    });
  }

  return jobs;
}

export function parseWorkingNomadsListingHtml(
  html: string,
  sourceUrl?: string
): WorkingNomadsListingParseResult {
  const jobs = extractWorkingNomadsJobItems(html);

  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    platform: "workingnomads",
    totalCount: jobs.length,
    jobs,
  };
}

export function normalizeWorkingNomadsListingUrl(listingUrl: string): string {
  return listingUrl.trim();
}
