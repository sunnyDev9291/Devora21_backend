import { Response, NextFunction } from "express";
import { claudeEnabled } from "../config/env";
import { ALLOWED_FRONTEND_ORIGINS } from "../config/frontend";
import { listClaudeModelsResponse, resolveClaudeModel } from "../lib/claude-models";
import { AppError } from "../middleware/errorHandler";
import { verifyAccessToken } from "../lib/jwt";
import {
  CLAUDE_MAX_OUTPUT_TOKENS,
  streamChatCompletion,
} from "../services/claude.service";
import * as apiKeyService from "../services/api-key.service";
import { prisma } from "../lib/prisma";
import { logger } from "../lib/logger";
import type { AuthenticatedRequest } from "../middleware/auth";
import type { ChatCompletionsInput, ClaudeChatInput } from "../validators/ai.validator";
import { buildResumeGeneratePrompt } from "../services/resume-generate.service";

function serviceUnavailable(res: Response): void {
  res.status(503).json({ error: "Claude API is not configured" });
}

/** No artificial app caps — always the model output ceiling. */
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

function startPlainTextStream(
  req: AuthenticatedRequest,
  res: Response,
  modelId: string
): void {
  applyStreamCors(req, res);
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // Disable nginx / compatible proxy response buffering so chunks reach the browser.
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("X-Model", modelId);
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
function buildPlainChatInput(
  body: ChatCompletionsInput,
  model: string
): ClaudeChatInput {
  return {
    messages: body.messages,
    maxTokens: resolveMaxTokens(body.maxTokens),
    jsonObject: false,
    model,
  };
}

async function loadResumeUser(userId: string): Promise<{
  id: string;
  email: string;
  emailVerified: boolean;
  resumeBuilderEnabled: boolean;
  isSuperAdmin: boolean;
  customPrompt: string | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      resumeBuilderEnabled: true,
      isSuperAdmin: true,
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
        isSuperAdmin: Boolean(user.isSuperAdmin),
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
        isSuperAdmin: Boolean(user.isSuperAdmin),
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
    isSuperAdmin: Boolean(user.isSuperAdmin),
  };
  return user;
}

/**
 * Resume mode (web + same logic as one-click generate):
 * stored DOCX structure + profile writing prompt + JD → Claude.
 * FE messages are ignored — FE only displays the stream and later signals render.
 */
async function buildResumeChatInput(
  req: AuthenticatedRequest,
  body: ChatCompletionsInput,
  model: string
): Promise<ClaudeChatInput> {
  const user = await resolveAiUser(req, body);
  const jobContext = extractJobContext(req, body);

  const bundle = await buildResumeGeneratePrompt({
    userId: user.id,
    jobTitle: jobContext.jobTitle || body.jobTitle || "",
    jobDescription: jobContext.jobDescription || body.jobDescription || "",
    templateId: body.templateId,
    customPrompt: body.customPrompt,
    profilePrompt: body.profilePrompt,
    promptContent: body.promptContent,
    context: "ai/chat/completions",
  });

  // Ignore FE/body maxTokens caps — always use model maximum output.
  return {
    messages: bundle.messages,
    jsonObject: true,
    maxTokens: resolveMaxTokens(body.maxTokens),
    model,
  };
}

/** Authenticated catalog for the FE Claude model dropdown. */
export function listClaudeModelsHandler(
  _req: AuthenticatedRequest,
  res: Response
): void {
  res.status(200).json(listClaudeModelsResponse());
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
  let modelId: string;
  let bytesStreamed = 0;
  let firstByteAt: number | null = null;
  let endReason = "ok";

  try {
    modelId = resolveClaudeModel(body.model);
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

      input = await buildResumeChatInput(
        req,
        {
          ...body,
          ...jobContext,
        },
        modelId
      );
    } else {
      // Application Q&A is ordinary chat: no resume gate/profile prompt override.
      input = buildPlainChatInput(body, modelId);
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
    model: modelId,
  });

  try {
    await streamChatCompletion(input, {
      onUpstreamReady: () => {
        // Open client stream only after Anthropic accepts — connect errors stay JSON.
        startPlainTextStream(req, res, modelId);
      },
      onText: (text) => {
        if (!res.headersSent) {
          startPlainTextStream(req, res, modelId);
        }
        if (firstByteAt === null) {
          firstByteAt = Date.now();
          logger.info("ai.stream", "first_byte", {
            ttfbMs: firstByteAt - startedAt,
            authMode: mode,
            maxTokens: input.maxTokens,
            model: modelId,
          });
        }
        bytesStreamed += Buffer.byteLength(text, "utf8");
        writePlainTextChunk(res, text);
      },
    });
    endReason = bytesStreamed > 0 ? "complete" : "empty";
    if (!res.headersSent) {
      // Upstream OK but zero text — still close a plain stream cleanly.
      startPlainTextStream(req, res, modelId);
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
      model: modelId,
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
