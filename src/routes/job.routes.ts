import { Router } from "express";
import {
  checkEnglishTeamHandler,
  checkJobStreamHandler,
  crawlBuiltInHandler,
  crawlGetOnBoardHandler,
  crawlHiringCafeHandler,
  crawlHimalayasHandler,
  crawlJobicyHandler,
  crawlWorkableHandler,
  crawlWorkingNomadsHandler,
  discoverBuiltInHandler,
  discoverHiringCafeHandler,
  discoverWorkableHandler,
  discoverWorkingNomadsHandler,
  scrapeJobHandler,
} from "../controllers/job.controller";
import { requireAuth, requireResumeBuilder } from "../middleware/auth";
import { requireAiAuth } from "../middleware/aiAuth";
import { aiChatRateLimiter, jobScrapeRateLimiter } from "../middleware/rateLimit";
import { validateBody } from "../middleware/validate";
import {
  checkEnglishTeamSchema,
  crawlBuiltInSchema,
  crawlGetOnBoardSchema,
  crawlHiringCafeSchema,
  crawlHimalayasSchema,
  crawlJobicySchema,
  crawlWorkableSchema,
  crawlWorkingNomadsSchema,
  discoverBuiltInSchema,
  discoverHiringCafeSchema,
  discoverWorkableSchema,
  discoverWorkingNomadsSchema,
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
  "/crawl/hiringcafe",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlHiringCafeSchema),
  crawlHiringCafeHandler
);

router.post(
  "/crawl/workable",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlWorkableSchema),
  crawlWorkableHandler
);

router.post(
  "/crawl/workingnomads",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlWorkingNomadsSchema),
  crawlWorkingNomadsHandler
);

router.post(
  "/crawl/himalayas",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlHimalayasSchema),
  crawlHimalayasHandler
);

router.post(
  "/crawl/getonboard",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlGetOnBoardSchema),
  crawlGetOnBoardHandler
);

router.post(
  "/crawl/jobicy",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(crawlJobicySchema),
  crawlJobicyHandler
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
  "/discover/hiringcafe",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(discoverHiringCafeSchema),
  discoverHiringCafeHandler
);

router.post(
  "/discover/workable",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(discoverWorkableSchema),
  discoverWorkableHandler
);

router.post(
  "/discover/workingnomads",
  requireAuth,
  requireResumeBuilder,
  jobScrapeRateLimiter,
  validateBody(discoverWorkingNomadsSchema),
  discoverWorkingNomadsHandler
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
  requireAiAuth,
  aiChatRateLimiter,
  checkJobStreamHandler
);

router.post(
  "/check/english-team",
  requireAiAuth,
  aiChatRateLimiter,
  validateBody(checkEnglishTeamSchema),
  checkEnglishTeamHandler
);

export default router;
