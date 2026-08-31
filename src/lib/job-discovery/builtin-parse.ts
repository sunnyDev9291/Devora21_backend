export type BuiltInJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type BuiltInListingParseResult = {
  sourceUrl?: string;
  platform: "builtin";
  totalCount: number;
  jobs: BuiltInJobListingItem[];
};

export type BuiltInCrawlResult = {
  /** Page 1 listing URL (main URL). */
  sourceUrl: string;
  platform: "builtin";
  pagesScraped: number;
  totalCount: number;
  jobs: BuiltInJobListingItem[];
};

/** Built In remote ARG jobs — page 1 (main URL). */
export const DEFAULT_BUILTIN_CRAWL_URL =
  "https://builtin.com/jobs/remote/mid-level/senior/expert-leader?daysSinceUpdated=1&country=ARG&allLocations=true";

const BUILTIN_ORIGIN = "https://builtin.com";

type JsonLdListItem = {
  name?: string;
  url?: string;
  position?: number;
};

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

function extractJobIdFromUrl(url: string): string | null {
  const match = url.match(/\/(\d+)\/?(?:\?|$)/);
  return match?.[1] ?? null;
}

function toAbsoluteBuiltInUrl(url: string, baseUrl = BUILTIN_ORIGIN): string {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function extractJsonLdJobs(html: string): JsonLdListItem[] {
  const scriptMatch = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!scriptMatch?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(scriptMatch[1].trim()) as {
      "@graph"?: Array<{ "@type"?: string; itemListElement?: JsonLdListItem[] }>;
      itemListElement?: JsonLdListItem[];
    };

    const graphs = parsed["@graph"] ?? [parsed];
    for (const node of graphs) {
      if (node.itemListElement?.length) {
        return node.itemListElement.filter(
          (item) => typeof item.name === "string" && typeof item.url === "string"
        );
      }
    }
  } catch {
    return [];
  }

  return [];
}

function extractCompanyNamesByJobId(html: string): Map<string, string> {
  const companies = new Map<string, string>();
  const pattern =
    /data-id="company-title"[^>]*data-builtin-track-job-id="(\d+)"[^>]*>\s*<span>([^<]+)<\/span>/gi;

  for (const match of html.matchAll(pattern)) {
    const jobId = match[1];
    const companyName = decodeHtmlEntities(match[2]);
    if (jobId && companyName) {
      companies.set(jobId, companyName);
    }
  }

  return companies;
}

function extractHtmlJobCards(html: string): BuiltInJobListingItem[] {
  const jobs: BuiltInJobListingItem[] = [];
  const seen = new Set<string>();

  const titlePattern =
    /data-id="job-card-title"[^>]*data-alias="([^"]+)"[^>]*data-builtin-track-job-id="(\d+)"[^>]*>([^<]+)<\/a>/gi;

  for (const match of html.matchAll(titlePattern)) {
    const alias = match[1];
    const jobId = match[2];
    const jobTitle = decodeHtmlEntities(match[3]);
    if (!jobId || !jobTitle) continue;

    const jobUrl = toAbsoluteBuiltInUrl(alias || `/job/${jobId}`);
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    jobs.push({
      jobId,
      companyName: "",
      jobTitle,
      jobUrl,
    });
  }

  return jobs;
}

/**
 * Read the highest page number from Built In pagination controls.
 * Falls back to 1 when pagination is missing (single-page listing).
 */
export function extractBuiltInLastPageNumber(html: string): number {
  const pages = new Set<number>([1]);

  for (const match of html.matchAll(/aria-label="Go to [Pp]age (\d+)"/g)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) {
      pages.add(n);
    }
  }

  const paginationBlock =
    html.match(/<div id="pagination"[\s\S]*?<\/nav>/i)?.[0] ?? html;
  for (const match of paginationBlock.matchAll(/[?&]page=(\d+)/g)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && n > 0) {
      pages.add(n);
    }
  }

  return Math.max(...pages);
}

/** Normalize to page-1 main URL (strip any existing page param). */
export function normalizeBuiltInMainListingUrl(listingUrl: string): string {
  const url = new URL(listingUrl.trim());
  url.searchParams.delete("page");
  return url.href;
}

/** Page 1 = main URL without page param; page 2+ adds &page=N. */
export function buildBuiltInListingPageUrl(mainUrl: string, page: number): string {
  const url = new URL(normalizeBuiltInMainListingUrl(mainUrl));
  if (page <= 1) {
    url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(page));
  }
  return url.href;
}

/**
 * Parse a Built In job listing page (Zyte browserHtml or saved sample).
 * Prefers JSON-LD for title + URL; enriches with company names from HTML cards.
 */
export function parseBuiltInListingHtml(
  html: string,
  sourceUrl?: string
): BuiltInListingParseResult {
  const companiesByJobId = extractCompanyNamesByJobId(html);
  const jsonLdItems = extractJsonLdJobs(html);
  const jobs: BuiltInJobListingItem[] = [];
  const seen = new Set<string>();

  for (const item of jsonLdItems) {
    const jobTitle = decodeHtmlEntities(item.name ?? "");
    const jobUrl = toAbsoluteBuiltInUrl(item.url ?? "");
    const jobId = extractJobIdFromUrl(jobUrl);
    if (!jobId || !jobTitle || !jobUrl || seen.has(jobId)) {
      continue;
    }

    seen.add(jobId);
    jobs.push({
      jobId,
      companyName: companiesByJobId.get(jobId) ?? "",
      jobTitle,
      jobUrl,
    });
  }

  if (jobs.length === 0) {
    for (const card of extractHtmlJobCards(html)) {
      if (seen.has(card.jobId)) continue;
      seen.add(card.jobId);
      jobs.push({
        ...card,
        companyName: companiesByJobId.get(card.jobId) ?? "",
      });
    }
  } else {
    for (const job of jobs) {
      if (!job.companyName) {
        job.companyName = companiesByJobId.get(job.jobId) ?? "";
      }
    }
  }

  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    platform: "builtin",
    totalCount: jobs.length,
    jobs,
  };
}
