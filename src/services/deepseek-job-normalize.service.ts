import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEEPSEEK_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;

export type NormalizedJobFields = {
  companyName: string;
  jobTitle: string;
  jobDescription: string;
};

export type NormalizeJobResult = {
  fields: NormalizedJobFields;
  /** True when companyName, jobTitle, and jobDescription are all non-blank. */
  complete: boolean;
  attempts: number;
};

const SYSTEM_PROMPT = `You extract job posting fields from raw scraper JSON.
Return ONLY a single JSON object with exactly these keys:
- companyName (string): hiring company display name — REQUIRED, must not be blank
- jobTitle (string): job title / role name — REQUIRED, must not be blank
- jobDescription (string): full job description text (plain text, no markdown fences) — REQUIRED, must not be blank

Rules:
- companyName, jobTitle, and jobDescription are ALL mandatory. Never return empty strings for them.
- Prefer the most complete job description available in the input.
- companyName MUST be a human company name (e.g. "Equate Media"), NEVER a URL, LinkedIn link, tracking query, or path.
- If the only company signal is a URL like linkedin.com/company/equate-media, convert the slug to a proper name ("Equate Media").
- Infer companyName from hiringOrganization name, page title, or description when needed — not from raw hrefs.
- Infer jobTitle from title fields or the start of the description when needed.
- Do not invent unrelated companies or roles; extract from the provided scraper data only.
- Do not include any other keys.
- Do not wrap the JSON in markdown code fences.`;

function asString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^www\./i.test(value);
}

/** Turn "equate-media" / "equate_media" into "Equate Media". */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * If the model returned a company page URL (common on LinkedIn scrapes),
 * recover a display name from the path instead of storing the URL.
 */
export function sanitizeCompanyName(raw: string): string {
  const value = raw.trim();
  if (!value || !looksLikeUrl(value)) {
    return value;
  }

  try {
    const href = value.startsWith("http") ? value : `https://${value}`;
    const parsed = new URL(href);
    const linkedInCompany = parsed.pathname.match(
      /\/company\/([^/?#]+)/i
    );
    if (linkedInCompany?.[1]) {
      return humanizeSlug(decodeURIComponent(linkedInCompany[1]));
    }
    const firstSeg = parsed.pathname.split("/").filter(Boolean)[0];
    if (firstSeg && !/^(jobs?|in|life|posts?|feed)$/i.test(firstSeg)) {
      return humanizeSlug(decodeURIComponent(firstSeg));
    }
  } catch {
    // fall through
  }

  return "";
}

function stripFences(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  } else if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json|JSON)?\s*\r?\n?/, "")
      .replace(/\r?\n?```\s*$/, "")
      .trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  return text;
}

function isComplete(fields: NormalizedJobFields): boolean {
  return (
    fields.companyName.length > 0 &&
    fields.jobTitle.length > 0 &&
    fields.jobDescription.length > 0
  );
}

function parseFields(content: string): NormalizedJobFields {
  const parsed = JSON.parse(stripFences(content)) as Record<string, unknown>;
  const companyRaw =
    asString(parsed.companyName) || asString(parsed.company_name);
  return {
    companyName: sanitizeCompanyName(companyRaw),
    jobTitle: asString(parsed.jobTitle) || asString(parsed.job_title),
    jobDescription:
      asString(parsed.jobDescription) || asString(parsed.job_description),
  };
}

function missingFieldNames(fields: NormalizedJobFields): string[] {
  const missing: string[] = [];
  if (!fields.companyName) missing.push("companyName");
  if (!fields.jobTitle) missing.push("jobTitle");
  if (!fields.jobDescription) missing.push("jobDescription");
  return missing;
}

async function callDeepSeekOnce(
  zyteRaw: unknown,
  attempt: number,
  previous?: NormalizedJobFields
): Promise<NormalizedJobFields> {
  const scraperJson = JSON.stringify(zyteRaw).slice(0, 120_000);

  const userParts = [
    `Extract companyName, jobTitle, and jobDescription from this scraper JSON.`,
    `All three fields are mandatory and must be non-empty strings.`,
    "",
    scraperJson,
  ];

  if (attempt > 1 && previous) {
    const missing = missingFieldNames(previous);
    userParts.unshift(
      `Previous attempt returned blank required field(s): ${missing.join(", ") || "unknown"}.`,
      `Retry and return a complete JSON object with non-empty companyName, jobTitle, and jobDescription.`,
      `companyName must be a plain company name, never a URL.`,
      ""
    );
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userParts.join("\n") },
      ],
      max_tokens: 8192,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    }),
    signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
  });

  if (!response.ok) {
    let detail = `DeepSeek request failed (${response.status})`;
    try {
      const errBody = (await response.json()) as { error?: { message?: string } };
      if (errBody.error?.message) {
        detail = errBody.error.message;
      }
    } catch {
      // fall through
    }
    throw new AppError(502, detail);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new AppError(502, "DeepSeek returned an empty response");
  }

  try {
    return parseFields(content);
  } catch {
    throw new AppError(502, "DeepSeek returned invalid JSON");
  }
}

/**
 * Normalize scraper JSON into fixed job fields via DeepSeek.
 * Retries up to 3 times when any of companyName / jobTitle / jobDescription is blank.
 */
export async function normalizeJobFieldsWithDeepSeek(
  zyteRaw: unknown
): Promise<NormalizeJobResult> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new AppError(503, "DeepSeek API is not configured");
  }

  let lastFields: NormalizedJobFields = {
    companyName: "",
    jobTitle: "",
    jobDescription: "",
  };
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      lastFields = await callDeepSeekOnce(
        zyteRaw,
        attempt,
        attempt > 1 ? lastFields : undefined
      );
    } catch (err) {
      // Hard API/config errors should not burn silent retries as "blank".
      // Still retry transient/empty/invalid parse up to MAX_ATTEMPTS.
      if (err instanceof AppError && err.statusCode === 503) {
        throw err;
      }
      if (attempt === MAX_ATTEMPTS) {
        if (err instanceof AppError) {
          throw err;
        }
        throw new AppError(502, "Failed to normalize job fields");
      }
      continue;
    }

    if (isComplete(lastFields)) {
      return { fields: lastFields, complete: true, attempts };
    }
  }

  return { fields: lastFields, complete: false, attempts };
}
