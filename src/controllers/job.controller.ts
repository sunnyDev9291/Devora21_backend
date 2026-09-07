import { Response, NextFunction } from "express";
import { claudeEnabled, env } from "../config/env";
import {
  buildJobCheckUserMessage,
  DEFAULT_JOB_CHECK_SYSTEM_PROMPT,
} from "../lib/job-check/prompt";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { CLAUDE_MODEL, streamChatCompletion } from "../services/claude.service";
import { evaluateEnglishTeam } from "../services/english-team-check.service";
import {
  crawlBuiltInJobsFromUrl,
  discoverBuiltInJobsFromUrl,
} from "../services/builtin-discovery.service";
import {
  crawlHiringCafeJobsFromUrl,
  discoverHiringCafeJobsFromUrl,
} from "../services/hiringcafe-discovery.service";
import {
  crawlWorkingNomadsJobsFromUrl,
  discoverWorkingNomadsJobsFromUrl,
} from "../services/workingnomads-discovery.service";
import {
  crawlWorkableJobsFromUrl,
  discoverWorkableJobsFromUrl,
} from "../services/workable-discovery.service";
import { scrapeJobFromUrl } from "../services/zyte.service";
import {
  resolveListingUrlForUser,
  type ListingUrlPlatform,
} from "../lib/listing-urls";
import type {
  CrawlBuiltInInput,
  CrawlHiringCafeInput,
  CrawlWorkableInput,
  CrawlWorkingNomadsInput,
  DiscoverBuiltInInput,
  DiscoverHiringCafeInput,
  DiscoverWorkableInput,
  DiscoverWorkingNomadsInput,
  CheckEnglishTeamInput,
  ScrapeJobInput,
} from "../validators/job.validator";

const JOB_CHECK_MAX_TOKENS = 4096;

async function listingUrlForRequest(
  userId: string,
  platform: ListingUrlPlatform,
  requestedUrl?: string
): Promise<string> {
  return resolveListingUrlForUser(userId, platform, requestedUrl);
}

function startPlainTextStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Model", CLAUDE_MODEL);
  res.flushHeaders?.();
}

function writePlainTextChunk(res: Response, text: string): void {
  res.write(text);
  const flushable = res as Response & { flush?: () => void };
  flushable.flush?.();
}

export async function scrapeJobHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const result = await scrapeJobFromUrl(req.body as ScrapeJobInput);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * English-team Yes/No from job title + description.
 * Prompt is owned by the backend (not the resume profile prompt).
 */
export async function checkEnglishTeamHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { jobTitle, jobDescription } = req.body as CheckEnglishTeamInput;
    const result = await evaluateEnglishTeam(jobTitle, jobDescription);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/**
 * Streaming Job Check — Claude plain-text analysis of job fields.
 * Prompt is owned by the backend; client only sends jobTitle/companyName/jobDescription.
 */
export async function checkJobStreamHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (!claudeEnabled) {
      res.status(503).json({ error: "Claude API is not configured" });
      return;
    }

    const companyName = String(body.companyName ?? "").trim();
    if (!companyName) {
      res.status(400).json({ error: "Company name is required." });
      return;
    }

    const jobTitle = String(body.jobTitle ?? "").trim();
    const jobDescription = String(body.jobDescription ?? "").trim();
    const systemPrompt =
      env.JOB_CHECK_SYSTEM_PROMPT?.trim() || DEFAULT_JOB_CHECK_SYSTEM_PROMPT;

    startPlainTextStream(res);

    try {
      await streamChatCompletion(
        {
          maxTokens: JOB_CHECK_MAX_TOKENS,
          jsonObject: false,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: buildJobCheckUserMessage(jobTitle, companyName, jobDescription),
            },
          ],
        },
        (text) => {
          writePlainTextChunk(res, text);
        }
      );
      res.end();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Job Check stream failed.";
      console.error("Job Check stream error:", message);

      if (!res.headersSent) {
        res.status(502).json({ error: message || "Job Check stream failed." });
        return;
      }

      writePlainTextChunk(
        res,
        `\n\n[error] ${message || "Job Check stream failed."}`
      );
      res.end();
    }
  } catch (err) {
    next(err);
  }
}

export async function discoverBuiltInHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const result = await discoverBuiltInJobsFromUrl(
      await listingUrlForRequest(
        req.authUser.id,
        "builtin",
        (req.body as DiscoverBuiltInInput).url
      )
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function crawlBuiltInHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const listingUrl = await listingUrlForRequest(
      req.authUser.id,
      "builtin",
      (req.body as CrawlBuiltInInput).url
    );
    const result = await crawlBuiltInJobsFromUrl(listingUrl);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function discoverHiringCafeHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const result = await discoverHiringCafeJobsFromUrl(
      await listingUrlForRequest(
        req.authUser.id,
        "hiringcafe",
        (req.body as DiscoverHiringCafeInput).url
      )
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function crawlHiringCafeHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const listingUrl = await listingUrlForRequest(
      req.authUser.id,
      "hiringcafe",
      (req.body as CrawlHiringCafeInput).url
    );
    const result = await crawlHiringCafeJobsFromUrl(listingUrl);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function discoverWorkableHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const result = await discoverWorkableJobsFromUrl(
      await listingUrlForRequest(
        req.authUser.id,
        "workable",
        (req.body as DiscoverWorkableInput).url
      )
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function crawlWorkableHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const listingUrl = await listingUrlForRequest(
      req.authUser.id,
      "workable",
      (req.body as CrawlWorkableInput).url
    );
    const result = await crawlWorkableJobsFromUrl(listingUrl);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function discoverWorkingNomadsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const result = await discoverWorkingNomadsJobsFromUrl(
      await listingUrlForRequest(
        req.authUser.id,
        "workingnomads",
        (req.body as DiscoverWorkingNomadsInput).url
      )
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function crawlWorkingNomadsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const listingUrl = await listingUrlForRequest(
      req.authUser.id,
      "workingnomads",
      (req.body as CrawlWorkingNomadsInput).url
    );
    const result = await crawlWorkingNomadsJobsFromUrl(listingUrl);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
