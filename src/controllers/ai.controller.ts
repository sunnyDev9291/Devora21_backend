import { Response, NextFunction } from "express";
import { claudeEnabled } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { verifyAccessToken } from "../lib/jwt";
import { resumeJsonOutputContract } from "../lib/resume/output-contract";
import { CLAUDE_MODEL, CLAUDE_MAX_OUTPUT_TOKENS, streamChatCompletion } from "../services/claude.service";
import * as apiKeyService from "../services/api-key.service";
import { prisma } from "../lib/prisma";
import type { AuthenticatedRequest } from "../middleware/auth";
import type { ChatCompletionsInput, ClaudeChatInput } from "../validators/ai.validator";
import { assertWorksWithEnglishTeam } from "../services/english-team-check.service";

function serviceUnavailable(res: Response): void {
  res.status(503).json({ error: "Claude API is not configured" });
}

function startPlainTextStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
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

function singleHeader(
  req: AuthenticatedRequest,
  name: string
): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && raw[0]?.trim()) return raw[0].trim();
  return undefined;
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
 * Profile prompt is the ONLY system instruction.
 * Any client/BFF system messages are stripped and ignored.
 */
async function applyUserProfilePrompt(
  req: AuthenticatedRequest,
  body: ChatCompletionsInput
): Promise<ClaudeChatInput> {
  const nonSystemMessages = body.messages.filter((m) => m.role !== "system");
  const user = await resolveAiUser(req, body);

  const prompt = user.customPrompt?.trim();
  if (!prompt) {
    throw new AppError(
      422,
      "Profile prompt not found. Upload a prompt in your Devora21 profile before generating a resume."
    );
  }

  // Infer layout hint from user messages if present; default bullets.
  const userBlob = nonSystemMessages.map((m) => m.content).join("\n").toLowerCase();
  const layout = /\bprojects?\b/.test(userBlob) && /business\s*challenge|assigned\s*responsibility/.test(userBlob)
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

  const { userId: _userId, jobTitle: _jobTitle, jobDescription: _jobDescription, skipEnglishTeamGate: _skip, ...rest } =
    body;


  // Claude has no true unlimited mode — use the sync API hard cap (64k).
  return {
    ...rest,
    jsonObject: true,
    maxTokens: CLAUDE_MAX_OUTPUT_TOKENS,
    messages: [{ role: "system", content: systemContent }, ...nonSystemMessages],
  };
}

/**
 * Resume / AI generation: stream Claude text to the client as it arrives.
 * (Buffering the full reply caused Netlify BFF timeouts → "An unknown error has occurred".)
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

  try {
    // Gate unless user explicitly confirmed Continue creating.
    await assertWorksWithEnglishTeam(body.jobTitle, body.jobDescription, {
      skip: body.skipEnglishTeamGate === true,
      userId: req.authUser?.id ?? body.userId,
      context: "ai/chat/completions",
    });
  } catch (err) {
    next(err);
    return;
  }

  let input: ClaudeChatInput;
  try {
    input = await applyUserProfilePrompt(req, body);
  } catch (err) {
    next(err);
    return;
  }

  startPlainTextStream(res);

  try {
    // Stream tokens immediately so Netlify/BFF does not idle-timeout.
    await streamChatCompletion(input, (text) => {
      writePlainTextChunk(res, text);
    });
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      next(err);
      return;
    }

    const message = err instanceof Error ? err.message : "Stream failed";
    console.error("AI stream error:", message);
    res.write(`\n[error] ${message}`);
    res.end();
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
