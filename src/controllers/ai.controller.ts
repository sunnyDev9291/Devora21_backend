import { Response, NextFunction } from "express";
import { claudeEnabled } from "../config/env";
import { ALLOWED_FRONTEND_ORIGINS } from "../config/frontend";
import { AppError } from "../middleware/errorHandler";
import { verifyAccessToken } from "../lib/jwt";
import { resumeJsonOutputContract } from "../lib/resume/output-contract";
import {
  CLAUDE_MODEL,
  CLAUDE_MAX_OUTPUT_TOKENS,
  streamChatCompletion,
} from "../services/claude.service";
import * as apiKeyService from "../services/api-key.service";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import type { AuthenticatedRequest } from "../middleware/auth";
import type { ChatCompletionsInput, ClaudeChatInput } from "../validators/ai.validator";
import { resolveWritingPrompt } from "../lib/resume/resolve-writing-prompt";

function serviceUnavailable(res: Response): void {
  res.status(503).json({ error: "Claude API is not configured" });
}

/** No artificial app caps — always the Sonnet 5.5 output ceiling. */
function resolveMaxTokens(_requested?: number): number {
  void _requested;
  return CLAUDE_MAX_OUTPUT_TOKENS;
}

function authModeOf(req: AuthenticatedRequest): "userKey" | "internal" | "cookie" | "unknown" {
  if (req.authMethod === "internal") return "internal";
  if (req.authMethod === "apiKey") return "userKey";
  if (req.authMethod === "session") return "cookie";
  if (req.authUser?.id) return "cookie";
  return "unknown";
}

/** Ensure CORS headers are present on the streamed POST itself (not only OPTIONS). */
function applyStreamCors(req: AuthenticatedRequest, res: Response): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && ALLOWED_FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
}

function startPlainTextStream(req: AuthenticatedRequest, res: Response): void {
  applyStreamCors(req, res);
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable nginx / compatible proxy response buffering so chunks reach the browser.
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Model", CLAUDE_MODEL);
  // Avoid Content-Length so Transfer-Encoding: chunked is used.
  res.removeHeader("Content-Length");
  try {
    res.socket?.setNoDelay?.(true);
  } catch {
    // ignore
  }
  res.flushHeaders?.();
}

function writePlainTextChunk(res: Response, text: string): void {
  if (!text) return;
  res.write(text);
  // compression middleware exposes flush; also try cork/uncork path
  const flushable = res as Response & { flush?: () => void };
  if (typeof flushable.flush === "function") {
    flushable.flush();
  }
}

function singleHeader(
  req: AuthenticatedRequest,
  name: string
): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
  return undefined;
}

function singleQuery(
  req: AuthenticatedRequest,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const raw = req.query[name];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim()) {
      return raw[0].trim();
    }
  }
  return undefined;
}

/** Job context may be supplied in camel/snake case, body or query. */
function extractJobContext(
  req: AuthenticatedRequest,
  body: ChatCompletionsInput
): { jobTitle: string; jobDescription: string } {
  return {
    jobTitle:
      body.jobTitle ||
      singleQuery(req, "jobTitle", "job_title") ||
      "",
    jobDescription:
      body.jobDescription ||
      singleQuery(req, "jobDescription", "job_description") ||
      "",
  };
}

/** Plain Application Q&A keeps the frontend-provided system/history messages. */
function buildPlainChatInput(body: ChatCompletionsInput): ClaudeChatInput {
  return {
    messages: body.messages,
    maxTokens: resolveMaxTokens(body.maxTokens),
    jsonObject: false,
  };
}

async function loadResumeUser(userId: string): Promise<{
  id: string;
  email: string;
  emailVerified: boolean;
  resumeBuilderEnabled: boolean;
  customPrompt: string | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      resumeBuilderEnabled: true,
      customPrompt: true,
    },
  });
  if (!user) {
    throw new AppError(404, "User not found for profile prompt");
  }
  if (!user.resumeBuilderEnabled) {
    throw new AppError(403, "Resume builder access not enabled");
  }
  return user;
}

/**
 * Resolve which user owns the profile prompt.
 * Order: session/API key on request → X-User-Authorization → body.userId / X-User-Id
 * (userId headers only allowed with internal BFF key).
 */
async function resolveAiUser(
  req: AuthenticatedRequest,
  body: ChatCompletionsInput
): Promise<{ id: string; customPrompt: string | null }> {
  if (req.authUser?.id) {
    return loadResumeUser(req.authUser.id);
  }

  if (req.authMethod !== "internal") {
    throw new AppError(
      401,
      "Authentication required so the profile prompt can be applied"
    );
  }

  const userAuthHeader = singleHeader(req, "x-user-authorization");
  if (userAuthHeader) {
    const token = userAuthHeader.startsWith("Bearer ")
      ? userAuthHeader.slice(7).trim()
      : userAuthHeader;

    const apiUser = await apiKeyService.findUserByApiKey(token);
    if (apiUser) {
      const user = await loadResumeUser(apiUser.id);
      req.authUser = {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        resumeBuilderEnabled: user.resumeBuilderEnabled,
      };
      return user;
    }

    try {
      const payload = verifyAccessToken(token);
      const user = await loadResumeUser(payload.sub);
      req.authUser = {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        resumeBuilderEnabled: user.resumeBuilderEnabled,
      };
      return user;
    } catch {
      // fall through to userId
    }
  }

  const userId = body.userId?.trim() || singleHeader(req, "x-user-id");
  if (!userId) {
    throw new AppError(
      401,
      "Authentication required so the profile prompt can be applied. Send user session cookies, userId, X-User-Id, or X-User-Authorization."
    );
  }

  const user = await loadResumeUser(userId);
  req.authUser = {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    resumeBuilderEnabled: user.resumeBuilderEnabled,
  };
  return user;
}

/**
 * Resume mode: writing instructions from request body (preferred) or live profile store.
 * Client/BFF system messages are stripped in resume mode.
 */
async function applyUserProfilePrompt(
  req: AuthenticatedRequest,
  body: ChatCompletionsInput
): Promise<ClaudeChatInput> {
  const nonSystemMessages = body.messages.filter((m) => m.role !== "system");
  const user = await resolveAiUser(req, body);

  const resolved = await resolveWritingPrompt({
    userId: user.id,
    customPrompt: body.customPrompt,
    profilePrompt: body.profilePrompt,
    promptContent: body.promptContent,
    context: "ai/chat/completions",
  });
  const prompt = resolved.content;

  // Infer layout hint from user messages if present; default bullets.
  const userBlob = nonSystemMessages.map((m) => m.content).join("\n").toLowerCase();
  const layout =
    /\bprojects?\b/.test(userBlob) &&
    /business\s*challenge|assigned\s*responsibility/.test(userBlob)
      ? "projects"
      : "bullets";

  const systemContent = [
    "You must return JSON with non-empty string fields: title, summary, skills.",
    'skills must be a string (not an array). Example: "Python, React, AWS".',
    "",
    prompt,
    "",
    resumeJsonOutputContract(layout),
  ].join("\n");

  const {
    userId: _userId,
    jobTitle: _jobTitle,
    jobDescription: _jobDescription,
    skipEnglishTeamGate: _skip,
    customPrompt: _customPrompt,
    profilePrompt: _profilePrompt,
    promptContent: _promptContent,
    ...rest
  } = body;

  // Ignore FE/body maxTokens caps — always use model maximum output.
  return {
    ...rest,
    jsonObject: true,
    maxTokens: resolveMaxTokens(body.maxTokens),
    messages: [{ role: "system", content: systemContent }, ...nonSystemMessages],
  };
}

/**
 * Resume / AI generation: stream Claude text to the client as it arrives.
 * jsonObject:true still streams JSON characters — never wait for a complete object.
 */
export async function chatCompletionsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!claudeEnabled) {
    serviceUnavailable(res);
    return;
  }

  const body = req.body as ChatCompletionsInput;
  const startedAt = Date.now();
  let input: ClaudeChatInput;
  let bytesStreamed = 0;
  let firstByteAt: number | null = null;
  let endReason = "ok";

  try {
    // Only literal JSON boolean true means resume generation.
    if (body.jsonObject === true) {
      const jobContext = extractJobContext(req, body);
      if (!jobContext.jobTitle && !jobContext.jobDescription) {
        throw new AppError(
          400,
          "jobTitle or jobDescription is required for resume generation"
        );
      }
      // skipEnglishTeamGate is accepted (no-op) — never open an empty stream on gate failure.
      void body.skipEnglishTeamGate;

      input = await applyUserProfilePrompt(req, {
        ...body,
        ...jobContext,
      });
    } else {
      // Application Q&A is ordinary chat: no resume gate/profile prompt override.
      input = buildPlainChatInput(body);
    }
  } catch (err) {
    next(err);
    return;
  }

  const mode = authModeOf(req);
  logger.info("ai.stream", "start", {
    authMode: mode,
    userIdPresent: Boolean(req.authUser?.id),
    jobTitlePresent: Boolean(
      body.jobTitle || singleQuery(req, "jobTitle", "job_title")
    ),
    jsonObject: input.jsonObject,
    maxTokens: input.maxTokens,
  });

  try {
    await streamChatCompletion(input, {
      onUpstreamReady: () => {
        // Open client stream only after Anthropic accepts — connect errors stay JSON.
        startPlainTextStream(req, res);
      },
      onText: (text) => {
        if (!res.headersSent) {
          startPlainTextStream(req, res);
        }
        if (firstByteAt === null) {
          firstByteAt = Date.now();
          logger.info("ai.stream", "first_byte", {
            ttfbMs: firstByteAt - startedAt,
            authMode: mode,
            maxTokens: input.maxTokens,
          });
        }
        bytesStreamed += Buffer.byteLength(text, "utf8");
        writePlainTextChunk(res, text);
      },
    });
    endReason = bytesStreamed > 0 ? "complete" : "empty";
    if (!res.headersSent) {
      // Upstream OK but zero text — still close a plain stream cleanly.
      startPlainTextStream(req, res);
    }
    res.end();
  } catch (err) {
    endReason = "error";
    const message = err instanceof Error ? err.message : "Stream failed";
    console.error("AI stream error:", message);

    if (!res.headersSent) {
      // Upstream never started — return JSON (502/504).
      const lower = message.toLowerCase();
      const status =
        lower.includes("timeout") || lower.includes("aborted") ? 504 : 502;
      res.status(status).json({
        error: message,
        message,
      });
      return;
    }

    writePlainTextChunk(res, `\n[error] ${message}`);
    res.end();
  } finally {
    logger.info("ai.stream", "end", {
      authMode: mode,
      userIdPresent: Boolean(req.authUser?.id),
      jsonObject: input.jsonObject,
      maxTokens: input.maxTokens,
      ttfbMs: firstByteAt !== null ? firstByteAt - startedAt : null,
      bytesStreamed,
      totalMs: Date.now() - startedAt,
      endReason,
    });
  }
}

export async function chatCompletionsStreamHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Same plain-text Claude stream behavior as /chat/completions.
  return chatCompletionsHandler(req, res, next);
}

export function aiErrorHandler(
  err: Error,
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  console.error("AI proxy error:", err);
  const status = err instanceof AppError ? err.statusCode : 502;
  const body: {
    error: string;
    message: string;
    code?: string;
  } & Record<string, unknown> = {
    error: err.message || "Claude request failed",
    message: err.message || "Claude request failed",
  };
  if (err instanceof AppError) {
    if (err.code) body.code = err.code;
    if (err.details) Object.assign(body, err.details);
  }
  res.status(status).json(body);
}
