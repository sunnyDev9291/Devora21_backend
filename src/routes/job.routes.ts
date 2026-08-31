import { Router } from "express";
import {
  checkJobStreamHandler,
  crawlBuiltInHandler,
  discoverBuiltInHandler,
  scrapeJobHandler,
} from "../controllers/job.controller";
import { requireAuth, requireResumeBuilder } from "../middleware/auth";
import { aiChatRateLimiter, jobScrapeRateLimiter } from "../middleware/rateLimit";
import { validateBody } from "../middleware/validate";
import {
  crawlBuiltInSchema,
  discoverBuiltInSchema,
  scrapeJobSchema,
} from "../validators/job.validator";

const router = Router();

router.post(
  "/crawl/builtin",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlBuiltInSchema),
  crawlBuiltInHandler
);

router.post(
  "/discover/builtin",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(discoverBuiltInSchema),
  discoverBuiltInHandler
);

router.post(
  "/scrape",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(scrapeJobSchema),
  scrapeJobHandler
);

router.post(
  "/check/stream",
  requireAuth,
  requireResumeBuilder,
  aiChatRateLimiter,
  checkJobStreamHandler
);

export default router;
