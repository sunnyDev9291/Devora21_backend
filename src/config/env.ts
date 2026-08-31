import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(5000),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default("7d"),
  JWT_REFRESH_EXPIRES_IN: z.string().default("7d"),

  FRONTEND_URL: z.string().url().default("https://devora21-dev.netlify.app"),
  /** Comma-separated extra frontend origins (CORS + OAuth redirects). */
  FRONTEND_URLS: z.string().optional(),

  // Base URL for OAuth callbacks. Use IP for now, switch to https://api.devora21.com later.
  API_BASE_URL: z.string().url().default("http://31.44.7.64:5000"),

  COOKIE_DOMAIN: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default("noreply@devora21.com"),

  STORAGE_DIR: z.string().default("storage"),
  RESUME_MAX_FILE_SIZE_BYTES: z.coerce.number().default(10 * 1024 * 1024),
  LIBREOFFICE_PATH: z.string().optional(),

  /** Set to true to skip auth rate limiting (useful while developing locally). */
  DISABLE_RATE_LIMIT: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * When false, email verification is paused:
   * signup users are treated as verified and can log in immediately.
   */
  REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  CLAUDE_API_KEY: z.string().optional(),
  /** When true, /ai chat endpoints return mocked resume content (no Claude call). */
  AI_MOCK: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  /** Shared secret for server-to-server AI proxy calls (required in production). */
  AI_INTERNAL_API_KEY: z.string().optional(),

  /**
   * System prompt for POST /jobs/check/stream.
   * Optional — a built-in placeholder is used when unset.
   */
  JOB_CHECK_SYSTEM_PROMPT: z.string().optional(),

  /** DeepSeek API key — used to normalize Zyte scrape output for /jobs/scrape. */
  DEEPSEEK_API_KEY: z.string().optional(),

  /** Zyte API key for job link scraping. */
  ZYTE_API_KEY: z.string().optional(),

  /** Backblaze B2 — PDF hosting for /resume/from-job. */
  B2_KEY_ID: z.string().optional(),
  B2_APPLICATION_KEY: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  /** When true, return S3-compatible presigned URLs instead of friendly /file/ URLs. */
  B2_USE_PRESIGNED_URL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  B2_PRESIGN_EXPIRES_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const isProduction = env.NODE_ENV === "production";

export const rateLimitEnabled = isProduction && !env.DISABLE_RATE_LIMIT;

/** Cross-site cookies (Netlify → API) require Secure + SameSite=None, which needs HTTPS on the API. */
export const isSecureCookies = env.API_BASE_URL.startsWith("https://");

export const googleOAuthEnabled =
  Boolean(env.GOOGLE_CLIENT_ID) && Boolean(env.GOOGLE_CLIENT_SECRET);

export const emailEnabled =
  Boolean(env.SMTP_HOST) && Boolean(env.SMTP_USER) && Boolean(env.SMTP_PASS);

/** When false, signup/login skip email verification. */
export const emailVerificationRequired = env.REQUIRE_EMAIL_VERIFICATION;

export const aiMockEnabled = env.AI_MOCK;
export const claudeEnabled = aiMockEnabled || Boolean(env.CLAUDE_API_KEY);
export const deepseekEnabled = Boolean(env.DEEPSEEK_API_KEY);
export const zyteEnabled = Boolean(env.ZYTE_API_KEY);
export const backblazeEnabled =
  Boolean(env.B2_KEY_ID) &&
  Boolean(env.B2_APPLICATION_KEY) &&
  Boolean(env.B2_BUCKET);
