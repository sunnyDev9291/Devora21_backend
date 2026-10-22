import { env, aiMockEnabled } from "../config/env";
import {
  CLAUDE_MODEL as DEFAULT_CLAUDE_MODEL,
  CLAUDE_MAX_OUTPUT_TOKENS_CEILING,
  getClaudeMaxOutputTokens,
  getClaudeThinkingConfig,
  resolveClaudeModel,
} from "../lib/claude-models";
import type { ClaudeChatInput } from "../validators/ai.validator";
import {
  createMockChatCompletion,
  streamMockChatCompletion,
} from "./mock-ai.service";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
/** Default model when the request omits `model` (re-export for boot logs). */
export const CLAUDE_MODEL = DEFAULT_CLAUDE_MODEL;
/**
 * Highest output ceiling we request (Haiku 5.5 = 128k).
 * Prefer getClaudeMaxOutputTokens(model).
 */
export const CLAUDE_MAX_OUTPUT_TOKENS = CLAUDE_MAX_OUTPUT_TOKENS_CEILING;
/** Fail if Anthropic never starts sending the response body. */
const AI_CONNECT_TIMEOUT_MS = 30_000;
/** Fail if no stream bytes arrive for this long after headers / last chunk. */
const AI_IDLE_TIMEOUT_MS = 120_000;
/** Absolute ceiling for an entire stream (including generation). */
const AI_REQUEST_TIMEOUT_MS = 600_000;
const ANTHROPIC_VERSION = "2023-06-01";

interface ClaudeMessageResponse {
  error?: {
    message?: string;
  };
}

interface ClaudeStreamEvent {
  type?: string;
  content_block?: {
    type?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
  };
  error?: {
    message?: string;
  };
}

function claudeHeaders(): Record<string, string> {
  return {
    "x-api-key": env.CLAUDE_API_KEY!,
    "anthropic-version": ANTHROPIC_VERSION,
    "Content-Type": "application/json",
  };
}

function splitMessages(input: ClaudeChatInput): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const message of input.messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }

    messages.push({
      role: message.role,
      content: message.content,
    });
  }

  if (input.jsonObject) {
    systemParts.push(
      "Respond with a single valid JSON object only. Do not wrap it in markdown code fences. Do not include any text before or after the JSON."
    );
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages,
  };
}

function resolveRequestModel(input: ClaudeChatInput): string {
  return resolveClaudeModel(input.model ?? null);
}

function buildClaudeBody(input: ClaudeChatInput, stream: boolean): Record<string, unknown> {
  const { system, messages } = splitMessages(input);
  const model = resolveRequestModel(input);
  const modelCeiling = getClaudeMaxOutputTokens(model);
  // Use the model’s Anthropic ceiling; never exceed it (Haiku = 64k).
  const requested =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? input.maxTokens
      : modelCeiling;
  const maxTokens = Math.min(requested, modelCeiling);

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    stream,
  };

  // Turn off up-front thinking so streamed text/JSON starts immediately.
  // Haiku 5.5: adaptive thinking is on by default (hidden) → ~30–60s blank
  // stream until text begins; use type "disabled". Sonnet/Opus 5.x: "between_tools".
  const thinking = getClaudeThinkingConfig(model);
  if (thinking) {
    body.thinking = thinking;
  }

  if (system) {
    body.system = system;
  }

  return body;
}

async function parseClaudeError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as ClaudeMessageResponse;
    if (data.error?.message) {
      return data.error.message;
    }
  } catch {
    // fall through
  }

  return `Claude request failed (${response.status})`;
}

/** Strip markdown fences Claude often wraps around JSON responses. */
export function normalizeModelContent(raw: string, jsonObject: boolean): string {
  let text = raw.trim();
  if (!text) {
    return text;
  }

  const fenced = text.match(/^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/);
  if (fenced?.[1]) {
    text = fenced[1].trim();
  } else if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json|JSON)?\s*\r?\n?/, "")
      .replace(/\r?\n?```\s*$/, "")
      .trim();
  }

  if (jsonObject) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }

  return text;
}

export async function createChatCompletion(
  input: ClaudeChatInput
): Promise<{ content: string; model: string }> {
  if (aiMockEnabled) {
    return createMockChatCompletion(input);
  }

  // Prefer Claude stream, then assemble full plain text (also strips fences).
  let assembled = "";
  await streamChatCompletion(input, (text) => {
    assembled += text;
  });

  const content = normalizeModelContent(assembled, input.jsonObject);
  if (!content) {
    throw new Error("Claude returned an empty response");
  }

  return { content, model: resolveRequestModel(input) };
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export type StreamChatHandlers = {
  /** Fired once Anthropic accepts the stream (before first text delta). */
  onUpstreamReady?: () => void;
  onText: (text: string) => void;
};

/**
 * Streams raw AI text chunks (plain text) from Claude's streaming API.
 * Caller writes these directly to the HTTP response body as they arrive —
 * never wait for a complete JSON object.
 *
 * Connect failures throw BEFORE onUpstreamReady so the HTTP handler can still
 * return JSON 502/504. After onUpstreamReady, mid-stream errors should be
 * written as plain-text `[error] …` lines.
 */
export async function streamChatCompletion(
  input: ClaudeChatInput,
  onTextOrHandlers: ((text: string) => void) | StreamChatHandlers
): Promise<void> {
  const handlers: StreamChatHandlers =
    typeof onTextOrHandlers === "function"
      ? { onText: onTextOrHandlers }
      : onTextOrHandlers;

  if (aiMockEnabled) {
    handlers.onUpstreamReady?.();
    await streamMockChatCompletion(input, handlers.onText);
    return;
  }

  const overallAbort = new AbortController();
  const overallTimer = setTimeout(
    () => overallAbort.abort(),
    AI_REQUEST_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await raceWithTimeout(
      fetch(CLAUDE_API_URL, {
        method: "POST",
        headers: claudeHeaders(),
        body: JSON.stringify(buildClaudeBody(input, true)),
        signal: overallAbort.signal,
      }),
      AI_CONNECT_TIMEOUT_MS,
      `Claude upstream connect timeout after ${AI_CONNECT_TIMEOUT_MS}ms`
    );
  } catch (err) {
    clearTimeout(overallTimer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Claude request aborted after ${AI_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(overallTimer);
    throw new Error(await parseClaudeError(response));
  }

  if (!response.body) {
    clearTimeout(overallTimer);
    throw new Error("Claude returned an empty stream");
  }

  // Upstream accepted — safe to open the client stream response now.
  handlers.onUpstreamReady?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let upstreamOpened = true;
  let textChars = 0;
  let sawThinking = false;
  let stopReason: string | null = null;

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void reader.cancel().catch(() => undefined);
      overallAbort.abort();
    }, AI_IDLE_TIMEOUT_MS);
  };

  resetIdle();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      resetIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }

        const payload = line.slice(6).trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(payload) as ClaudeStreamEvent;
        } catch {
          continue;
        }

        if (event.error?.message) {
          throw new Error(event.error.message);
        }

        if (
          event.type === "content_block_start" &&
          event.content_block?.type === "thinking"
        ) {
          sawThinking = true;
        }

        if (event.type === "message_delta" && event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        }

        // Only forward visible text — ignore thinking_delta / signature_delta.
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const text = event.delta.text;
          if (text) {
            textChars += text.length;
            handlers.onText(text);
          }
        }
      }
    }

    if (textChars === 0) {
      const hint = sawThinking
        ? " (upstream returned thinking only — max_tokens likely exhausted before text)"
        : "";
      throw new Error(
        `Claude returned empty text stream${hint}${
          stopReason ? ` stop_reason=${stopReason}` : ""
        }`
      );
    }
  } catch (err) {
    if (overallAbort.signal.aborted && upstreamOpened) {
      throw new Error(
        `Claude upstream idle/timeout after ${AI_IDLE_TIMEOUT_MS}ms without bytes`
      );
    }
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    reader.releaseLock();
  }
}
