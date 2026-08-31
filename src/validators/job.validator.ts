import { z } from "zod";

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
  url: z
    .string()
    .trim()
    .min(1, "url is required")
    .url("url must be a valid URL")
    .refine((value) => {
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
  /** Built In listing page 1 URL (main URL). Backend strips any `page` param and crawls all pages. */
  url: z
    .string()
    .trim()
    .min(1, "url is required")
    .url("url must be a valid URL")
    .refine((value) => {
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
