import dns from "node:dns";
import app from "./app";
import {
  env,
  googleOAuthEnabled,
  emailEnabled,
  emailVerificationRequired,
  rateLimitEnabled,
  claudeEnabled,
  aiMockEnabled,
  zyteEnabled,
  deepseekEnabled,
  backblazeEnabled,
} from "./config/env";
import { ALLOWED_FRONTEND_ORIGINS } from "./config/frontend";
import { verifyEmailTransport } from "./services/email.service";
import { prisma } from "./lib/prisma";

import { logger } from "./lib/logger";

dns.setDefaultResultOrder("ipv4first");

const server = app.listen(env.PORT, "0.0.0.0", async () => {
  logger.info("server", `Server running on http://0.0.0.0:${env.PORT}`);
  logger.info("server", `Environment: ${env.NODE_ENV}`);
  logger.info("server", `Frontend URL: ${env.FRONTEND_URL}`);
  logger.info("server", `Allowed frontend origins: ${ALLOWED_FRONTEND_ORIGINS.join(", ")}`);
  logger.info("server", `API base URL: ${env.API_BASE_URL}`);
  logger.info("server", `Live logs: ${env.API_BASE_URL}/logs/viewer (login required)`);
  console.log(`Google OAuth: ${googleOAuthEnabled ? "enabled" : "not configured"}`);
  if (!googleOAuthEnabled) {
    console.log(`  Google callback: ${env.API_BASE_URL}/auth/google/callback`);
  }
  console.log(`Email (SMTP): ${emailEnabled ? "configured" : "not configured (console only)"}`);
  console.log(
    `Email verification: ${emailVerificationRequired ? "required" : "paused (signup can log in immediately)"}`
  );
  console.log(
    `Claude AI: ${claudeEnabled ? (aiMockEnabled ? "MOCK enabled" : "enabled") : "not configured"}`
  );
  if (claudeEnabled) {
    if (aiMockEnabled) {
      console.log("  AI responses: mocked (no Claude API calls)");
    } else {
      console.log("  Model: claude-sonnet-4-6 (thinking off; plain-text Claude stream)");
    }
    console.log(
      `  AI internal auth: ${env.AI_INTERNAL_API_KEY ? "required (Bearer token)" : "open (local dev only)"}`
    );
  }
  console.log(`Zyte scrape: ${zyteEnabled ? "enabled" : "not configured"}`);
  console.log(
    `DeepSeek job normalize: ${deepseekEnabled ? "enabled" : "not configured"}`
  );
  console.log(`Backblaze B2 PDF host: ${backblazeEnabled ? "enabled" : "not configured"}`);
  console.log(`Auth rate limit: ${rateLimitEnabled ? "enabled" : "disabled"}`);
  if (emailEnabled) {
    try {
      await verifyEmailTransport();
      console.log(`  SMTP connection verified (${env.SMTP_HOST}:${env.SMTP_PORT})`);
    } catch (err) {
      console.error(`  SMTP connection failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    console.log(`  Verification emails log to console until SMTP_HOST, SMTP_USER, SMTP_PASS are set`);
  }
});

async function shutdown(): Promise<void> {
  logger.info("server", "Shutting down...");
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
