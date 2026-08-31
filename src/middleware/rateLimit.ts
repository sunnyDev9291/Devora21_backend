import { RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { rateLimitEnabled } from "../config/env";
import type { AuthenticatedRequest } from "./auth";

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later" },
});

const onboardingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authUser = (req as AuthenticatedRequest).authUser;
    return authUser?.id ?? "anonymous";
  },
  validate: { keyGeneratorIpFallback: false },
  message: { message: "Too many onboarding requests, please try again later" },
});

/** Always on — Firecrawl credits / abuse sensitive. */
const jobScrapeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authUser = (req as AuthenticatedRequest).authUser;
    return authUser?.id ?? req.ip ?? "anonymous";
  },
  validate: { keyGeneratorIpFallback: false },
  message: {
    error: "Too many scrape requests, please try again later",
    message: "Too many scrape requests, please try again later",
  },
});

/** Always on — Claude credits / abuse sensitive. */
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const authUser = (req as AuthenticatedRequest).authUser;
    return authUser?.id ?? req.ip ?? "anonymous";
  },
  validate: { keyGeneratorIpFallback: false },
  message: {
    error: "Too many AI requests, please try again later",
    message: "Too many AI requests, please try again later",
  },
});

const noOp: RequestHandler = (_req, _res, next) => next();

export const authRateLimiter: RequestHandler = rateLimitEnabled ? limiter : noOp;
export const onboardingRateLimiter: RequestHandler = rateLimitEnabled
  ? onboardingLimiter
  : noOp;
export const jobScrapeRateLimiter: RequestHandler = jobScrapeLimiter;
export const aiChatRateLimiter: RequestHandler = aiChatLimiter;
