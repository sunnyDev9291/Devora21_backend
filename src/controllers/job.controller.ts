import { Response, NextFunction } from "express";
import { claudeEnabled, env } from "../config/env";
import {
  buildJobCheckUserMessage,
  DEFAULT_JOB_CHECK_SYSTEM_PROMPT,
} from "../lib/job-check/prompt";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import { CLAUDE_MODEL, streamChatCompletion } from "../services/claude.service";
import {
  crawlBuiltInJobsFromUrl,
  discoverBuiltInJobsFromUrl,
} from "../services/builtin-discovery.service";
import { scrapeJobFromUrl } from "../services/zyte.service";
import type {
  CrawlBuiltInInput,
  DiscoverBuiltInInput,
  ScrapeJobInput,
} from "../validators/job.validator";

const JOB_CHECK_MAX_TOKENS = 4096;

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
 * Streaming Job Check — Claude plain-text analysis of job fields.
 * Prompt is owned by the backend; client only sends jobTitle/companyName/jobDescription.
 */
export async function checkJobStreamHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    if (!claudeEnabled) {
      res.status(503).json({ error: "Claude API is not configured" });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
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
      (req.body as DiscoverBuiltInInput).url
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

    const listingUrl = (req.body as CrawlBuiltInInput).url.trim();
    const result = await crawlBuiltInJobsFromUrl(listingUrl);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
