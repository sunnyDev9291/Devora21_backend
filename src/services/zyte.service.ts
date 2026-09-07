import { zyteExtract } from "../lib/zyte-client";
import { AppError } from "../middleware/errorHandler";
import { normalizeJobFieldsWithDeepSeek } from "./deepseek-job-normalize.service";
import type {
  JobScrapeConfidence,
  JobScrapeResult,
  JobScrapeSource,
  ScrapeJobInput,
} from "../validators/job.validator";

type ZyteExtractResponse = {
  jobPosting?: unknown;
  url?: string;
  statusCode?: number;
  error?: string;
  detail?: string;
  httpResponseBody?: string;
  browserHtml?: string;
};

async function fetchZyteRaw(targetUrl: string): Promise<ZyteExtractResponse> {
  return zyteExtract({
    url: targetUrl,
    jobPosting: true,
    jobPostingOptions: {
      extractFrom: "browserHtml",
    },
  }) as Promise<ZyteExtractResponse>;
}

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function detectSource(url: string): JobScrapeSource {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("greenhouse.io")) return "greenhouse";
    if (host.includes("lever.co")) return "lever";
    if (host.includes("ashbyhq.com")) return "ashby";
  } catch {
    // fall through
  }
  return "generic";
}

function scoreConfidence(fields: {
  jobTitle: string;
  companyName: string;
  jobDescription: string;
}): JobScrapeConfidence {
  const hasTitle = fields.jobTitle.length >= 2;
  const hasCompany = fields.companyName.length >= 2;
  const hasJd = fields.jobDescription.length >= 80;

  if (hasTitle && hasCompany && hasJd) return "high";
  if ((hasTitle || hasCompany) && hasJd) return "medium";
  if (hasTitle || hasCompany || hasJd) return "low";
  return "low";
}

function emptyResult(url: string, warning: string): JobScrapeResult {
  return {
    url,
    source: detectSource(url),
    companyName: "",
    jobTitle: "",
    jobDescription: "",
    confidence: "low",
    warning,
  };
}

/**
 * 1) Zyte extracts raw job page data
 * 2) DeepSeek normalizes into fixed { companyName, jobTitle, jobDescription }
 */
export async function scrapeJobFromUrl(input: ScrapeJobInput): Promise<JobScrapeResult> {
  const targetUrl = input.url.trim();

  let zyteRaw: ZyteExtractResponse;
  try {
    zyteRaw = await fetchZyteRaw(targetUrl);
  } catch (err) {
    if (err instanceof AppError && (err.statusCode === 503 || err.statusCode === 400)) {
      throw err;
    }
    const message =
      err instanceof AppError
        ? err.message
        : "Could not scrape the job page. Paste the job description manually.";
    return emptyResult(targetUrl, message);
  }

  const pageUrl = asString(zyteRaw.url) || targetUrl;

  // Prefer jobPosting blob; fall back to full Zyte payload if missing.
  const deepSeekInput = zyteRaw.jobPosting
    ? { url: pageUrl, jobPosting: zyteRaw.jobPosting }
    : zyteRaw;

  let normalizeResult;
  try {
    normalizeResult = await normalizeJobFieldsWithDeepSeek(deepSeekInput);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 503) {
      throw err;
    }
    const message =
      err instanceof AppError
        ? err.message
        : "Failed to normalize job fields. Paste the job description manually.";
    return emptyResult(pageUrl, message);
  }

  const normalized = normalizeResult.fields;
  const confidence = scoreConfidence(normalized);

  let warning: string | undefined;
  if (!normalizeResult.complete) {
    warning =
      "Could not extract company name, job title, and job description after 3 attempts. You can edit fields or paste the job description manually.";
  } else if (confidence === "low") {
    warning =
      "Could not extract a full job posting. You can edit fields or paste the job description manually.";
  }

  return {
    url: pageUrl,
    source: detectSource(pageUrl),
    companyName: normalized.companyName,
    jobTitle: normalized.jobTitle,
    jobDescription: normalized.jobDescription,
    confidence: normalizeResult.complete ? confidence : "low",
    ...(warning ? { warning } : {}),
  };
}
