export type HiringCafeJobListingItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type HiringCafeListingParseResult = {
  sourceUrl?: string;
  platform: "hiringcafe";
  totalCount: number;
  jobs: HiringCafeJobListingItem[];
};

export type HiringCafeCrawlResult = {
  /** Page 0 listing URL (main URL). */
  sourceUrl: string;
  platform: "hiringcafe";
  pagesScraped: number;
  totalCount: number;
  jobs: HiringCafeJobListingItem[];
};

const HIRINGCAFE_ORIGIN = "https://hiringcafe.com";

/** Argentina remote + Past 24 hours + "engineer developer" (page 0 main URL). */
export const DEFAULT_HIRINGCAFE_CRAWL_URL =
  "https://hiringcafe.com/?searchState=" +
  encodeURIComponent(
    JSON.stringify({
      locations: [
        {
          formatted_address: "Argentina",
          types: ["country"],
          geometry: { location: { lat: -34.6142, lon: -58.3811 } },
          id: "user_country",
          address_components: [
            {
              long_name: "Argentina",
              short_name: "AR",
              types: ["country"],
            },
          ],
          options: {
            flexible_regions: ["anywhere_in_continent", "anywhere_in_world"],
          },
          workplace_types: ["Remote"],
        },
      ],
      searchQuery: "engineer developer",
      dateFetchedPastNDays: 2,
    })
  );

/** @deprecated Use DEFAULT_HIRINGCAFE_CRAWL_URL */
export const DEFAULT_HIRINGCAFE_LISTING_URL = DEFAULT_HIRINGCAFE_CRAWL_URL;

type HiringCafeSsrHit = {
  requisition_id?: string;
  id?: string;
  objectID?: string;
  is_expired?: boolean;
  job_information?: {
    title?: string;
    job_title_raw?: string;
  };
  v5_processed_job_data?: {
    company_name?: string;
  };
  enriched_company_data?: {
    name?: string;
  };
  attributed_org?: {
    name?: string;
  };
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

function toAbsoluteHiringCafeUrl(pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl, HIRINGCAFE_ORIGIN).href;
  } catch {
    return pathOrUrl;
  }
}

function requisitionIdFromJobSlug(slugPath: string): string {
  const slug = slugPath.replace(/^\/job\//, "").replace(/^\//, "");
  return slug.split("-").pop() ?? "";
}

/**
 * Visible listing cards expose a footer "Job Posting" link per job.
 * ssrHits also contains prefetched hits for other pages — ignore those.
 */
function extractVisibleJobSlugPaths(html: string): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();

  const pattern =
    /href="(\/job\/[^"]+)"[^>]*>\s*<span>Job Posting<\/span>/gi;

  for (const match of html.matchAll(pattern)) {
    const slugPath = match[1];
    const requisitionId = requisitionIdFromJobSlug(slugPath);
    if (!requisitionId || seen.has(requisitionId)) {
      continue;
    }
    seen.add(requisitionId);
    slugs.push(slugPath);
  }

  return slugs;
}

function buildSsrHitMap(html: string): Map<string, HiringCafeSsrHit> {
  const hits = extractSsrHits(html);
  const map = new Map<string, HiringCafeSsrHit>();
  for (const hit of hits) {
    const jobId = resolveJobId(hit);
    if (jobId && !map.has(jobId)) {
      map.set(jobId, hit);
    }
  }
  return map;
}

function extractSsrHits(html: string): HiringCafeSsrHit[] {
  const scriptMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!scriptMatch?.[1]) {
    return [];
  }

  try {
    const parsed = JSON.parse(scriptMatch[1].trim()) as {
      props?: { pageProps?: { ssrHits?: HiringCafeSsrHit[] } };
    };
    return parsed.props?.pageProps?.ssrHits ?? [];
  } catch {
    return [];
  }
}

function resolveCompanyName(hit: HiringCafeSsrHit): string {
  return (
    hit.v5_processed_job_data?.company_name?.trim() ||
    hit.enriched_company_data?.name?.trim() ||
    hit.attributed_org?.name?.trim() ||
    ""
  );
}

function resolveJobTitle(hit: HiringCafeSsrHit): string {
  return decodeHtmlEntities(
    hit.job_information?.title?.trim() ||
      hit.job_information?.job_title_raw?.trim() ||
      ""
  );
}

function resolveJobId(hit: HiringCafeSsrHit): string {
  return (
    hit.requisition_id?.trim() ||
    hit.objectID?.trim() ||
    hit.id?.trim() ||
    ""
  );
}

function titleFromJobSlug(slugPath: string): string {
  const slug = slugPath.replace(/^\/job\//, "");
  const body = slug.split("-").slice(0, -1).join(" ");
  return body
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Parse a HiringCafe search/listing page from static HTML (Zyte browserHtml or saved sample).
 * Visible jobs come from listing card "Job Posting" links; title/company are enriched from ssrHits.
 */
export function parseHiringCafeListingHtml(
  html: string,
  sourceUrl?: string
): HiringCafeListingParseResult {
  const slugPaths = extractVisibleJobSlugPaths(html);
  const hitByJobId = buildSsrHitMap(html);
  const jobs: HiringCafeJobListingItem[] = [];

  for (const slugPath of slugPaths) {
    const jobId = requisitionIdFromJobSlug(slugPath);
    if (!jobId) {
      continue;
    }

    const hit = hitByJobId.get(jobId);
    if (hit?.is_expired) {
      continue;
    }

    const jobTitle =
      (hit ? resolveJobTitle(hit) : "") || titleFromJobSlug(slugPath);
    if (!jobTitle) {
      continue;
    }

    jobs.push({
      jobId,
      companyName: hit ? resolveCompanyName(hit) : "",
      jobTitle,
      jobUrl: toAbsoluteHiringCafeUrl(slugPath),
    });
  }

  return {
    ...(sourceUrl ? { sourceUrl } : {}),
    platform: "hiringcafe",
    totalCount: jobs.length,
    jobs,
  };
}

/** Pagination hints from __NEXT_DATA__ (for future multi-page crawl). */
export function extractHiringCafePagination(html: string): {
  page: number;
  pageSize: number;
  totalCount: number;
  isLastPage: boolean;
} | null {
  const scriptMatch = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!scriptMatch?.[1]) {
    return null;
  }

  try {
    const parsed = JSON.parse(scriptMatch[1].trim()) as {
      props?: {
        pageProps?: {
          ssrPage?: number;
          ssrPageSize?: number;
          ssrTotalCount?: number;
          ssrIsLastPage?: boolean;
        };
      };
    };
    const pageProps = parsed.props?.pageProps;
    if (!pageProps) {
      return null;
    }

    return {
      page: pageProps.ssrPage ?? 0,
      pageSize: pageProps.ssrPageSize ?? 0,
      totalCount: pageProps.ssrTotalCount ?? 0,
      isLastPage: Boolean(pageProps.ssrIsLastPage),
    };
  } catch {
    return null;
  }
}

export function extractHiringCafeLastPageNumber(html: string): number {
  const pagination = extractHiringCafePagination(html);
  if (!pagination || pagination.pageSize <= 0) {
    return 0;
  }
  return Math.max(0, Math.ceil(pagination.totalCount / pagination.pageSize) - 1);
}

/** Strip any existing `page` param — page 0 main URL. */
export function normalizeHiringCafeMainListingUrl(listingUrl: string): string {
  const url = new URL(listingUrl.trim());
  url.searchParams.delete("page");
  return url.href;
}

/** Page 0 = main URL without `page`; page 1+ adds &page=N. */
export function buildHiringCafeListingPageUrl(
  mainUrl: string,
  page: number
): string {
  const url = new URL(normalizeHiringCafeMainListingUrl(mainUrl));
  if (page <= 0) {
    url.searchParams.delete("page");
  } else {
    url.searchParams.set("page", String(page));
  }
  return url.href;
}
