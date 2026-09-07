import { z } from "zod";

function optionalListingUrl(
  check: (value: string) => boolean,
  message: string
) {
  return z.preprocess((value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }, z.string().url("url must be a valid URL").refine(check, message).optional());
}

export const scrapeJobSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "url is required")
    .url("url must be a valid URL")
    .refine((value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    }, "url must use http or https"),
});

export type ScrapeJobInput = z.infer<typeof scrapeJobSchema>;

export const jobScrapeSourceSchema = z.enum(["greenhouse", "lever", "ashby", "generic"]);
export type JobScrapeSource = z.infer<typeof jobScrapeSourceSchema>;

export const jobScrapeConfidenceSchema = z.enum(["high", "medium", "low"]);
export type JobScrapeConfidence = z.infer<typeof jobScrapeConfidenceSchema>;

/** Stable frontend contract for job scrape. */
export type JobScrapeResult = {
  url: string;
  source: JobScrapeSource;
  companyName: string;
  jobTitle: string;
  jobDescription: string;
  confidence: JobScrapeConfidence;
  warning?: string;
};

export const discoverBuiltInSchema = z.object({
  url: optionalListingUrl((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === "builtin.com" || host.endsWith(".builtin.com");
    } catch {
      return false;
    }
  }, "url must be a Built In jobs listing page"),
});

export type DiscoverBuiltInInput = z.infer<typeof discoverBuiltInSchema>;

export type BuiltInJobDiscoveryItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type BuiltInJobDiscoveryResult = {
  sourceUrl: string;
  platform: "builtin";
  totalCount: number;
  jobs: BuiltInJobDiscoveryItem[];
};

export const crawlBuiltInSchema = z.object({
  /** Built In listing page 1 URL. Optional when saved on the user profile. */
  url: optionalListingUrl((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === "builtin.com" || host.endsWith(".builtin.com");
    } catch {
      return false;
    }
  }, "url must be a Built In jobs listing page"),
});

export type CrawlBuiltInInput = z.infer<typeof crawlBuiltInSchema>;

export type BuiltInJobCrawlResult = {
  sourceUrl: string;
  platform: "builtin";
  pagesScraped: number;
  totalCount: number;
  jobs: BuiltInJobDiscoveryItem[];
};

function isHiringCafeHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "hiringcafe.com" || host.endsWith(".hiringcafe.com");
  } catch {
    return false;
  }
}

export const discoverHiringCafeSchema = z.object({
  url: optionalListingUrl(
    isHiringCafeHost,
    "url must be a HiringCafe search listing page"
  ),
});

export type DiscoverHiringCafeInput = z.infer<typeof discoverHiringCafeSchema>;

export type HiringCafeJobDiscoveryItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type HiringCafeJobDiscoveryResult = {
  sourceUrl: string;
  platform: "hiringcafe";
  totalCount: number;
  jobs: HiringCafeJobDiscoveryItem[];
};

export const crawlHiringCafeSchema = z.object({
  /** HiringCafe listing page 0 URL. Optional when saved on the user profile. */
  url: optionalListingUrl(
    isHiringCafeHost,
    "url must be a HiringCafe search listing page"
  ),
});

export type CrawlHiringCafeInput = z.infer<typeof crawlHiringCafeSchema>;

export type HiringCafeJobCrawlResult = {
  sourceUrl: string;
  platform: "hiringcafe";
  pagesScraped: number;
  totalCount: number;
  jobs: HiringCafeJobDiscoveryItem[];
};

function isWorkableHost(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "jobs.workable.com" || host.endsWith(".jobs.workable.com")) &&
      parsed.pathname.startsWith("/search")
    );
  } catch {
    return false;
  }
}

export const discoverWorkableSchema = z.object({
  url: optionalListingUrl(
    isWorkableHost,
    "url must be a Workable jobs search listing page"
  ),
});

export type DiscoverWorkableInput = z.infer<typeof discoverWorkableSchema>;

export type WorkableJobDiscoveryItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type WorkableJobDiscoveryResult = {
  sourceUrl: string;
  platform: "workable";
  totalCount: number;
  jobs: WorkableJobDiscoveryItem[];
};

export const crawlWorkableSchema = z.object({
  /** Workable search URL. Optional when saved on the user profile. */
  url: optionalListingUrl(
    isWorkableHost,
    "url must be a Workable jobs search listing page"
  ),
});

export type CrawlWorkableInput = z.infer<typeof crawlWorkableSchema>;

export type WorkableJobCrawlResult = {
  sourceUrl: string;
  platform: "workable";
  pagesScraped: number;
  totalCount: number;
  jobs: WorkableJobDiscoveryItem[];
};

function isWorkingNomadsHost(value: string): boolean {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return (
      (host === "workingnomads.com" || host.endsWith(".workingnomads.com")) &&
      parsed.pathname === "/jobs"
    );
  } catch {
    return false;
  }
}

export const discoverWorkingNomadsSchema = z.object({
  url: optionalListingUrl(
    isWorkingNomadsHost,
    "url must be a Working Nomads jobs listing page"
  ),
});

export type DiscoverWorkingNomadsInput = z.infer<
  typeof discoverWorkingNomadsSchema
>;

export type WorkingNomadsJobDiscoveryItem = {
  jobId: string;
  companyName: string;
  jobTitle: string;
  jobUrl: string;
};

export type WorkingNomadsJobDiscoveryResult = {
  sourceUrl: string;
  platform: "workingnomads";
  totalCount: number;
  jobs: WorkingNomadsJobDiscoveryItem[];
};

export const crawlWorkingNomadsSchema = z.object({
  /** Working Nomads listing URL. Optional when saved on the user profile. */
  url: optionalListingUrl(
    isWorkingNomadsHost,
    "url must be a Working Nomads jobs listing page"
  ),
});

export type CrawlWorkingNomadsInput = z.infer<typeof crawlWorkingNomadsSchema>;

export type WorkingNomadsJobCrawlResult = {
  sourceUrl: string;
  platform: "workingnomads";
  pagesScraped: number;
  totalCount: number;
  jobs: WorkingNomadsJobDiscoveryItem[];
};

/** POST /jobs/check/english-team — Yes/No English-team analysis. */
export const checkEnglishTeamSchema = z
  .object({
    jobTitle: z.string().trim().optional().default(""),
    jobDescription: z.string().trim().optional().default(""),
  })
  .refine(
    (value) => value.jobTitle.length > 0 || value.jobDescription.length > 0,
    {
      message: "jobTitle or jobDescription is required",
      path: ["jobTitle"],
    }
  );

export type CheckEnglishTeamInput = z.infer<typeof checkEnglishTeamSchema>;

export type CheckEnglishTeamResult = {
  answer: "Yes" | "No";
  workWithEnglishTeam: boolean;
};
