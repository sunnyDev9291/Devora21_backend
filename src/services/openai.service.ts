import { env, aiMockEnabled, openAiEnabled } from "../config/env";
import {
  getClaudeMaxOutputTokens,
  resolveClaudeModel,
} from "../lib/claude-models";
import type { ClaudeChatInput } from "../validators/ai.validator";
import {
  createMockChatCompletion,
  streamMockChatCompletion,
} from "./mock-ai.service";

export type OpenAiStreamChatHandlers = {
  onUpstreamReady?: () => void;
  onText: (text: string) => void;
};

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const AI_CONNECT_TIMEOUT_MS = 30_000;
const AI_IDLE_TIMEOUT_MS = 120_000;
const AI_REQUEST_TIMEOUT_MS = 600_000;

function openAiHeaders(): Record<string, string> {
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is not configured");
  }
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY.trim()}`,
    "Content-Type": "application/json",
  };
}

function resolveRequestModel(input: ClaudeChatInput): string {
  return resolveClaudeModel(input.model ?? null);
}

function buildOpenAiMessages(
  input: ClaudeChatInput
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const messages = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (input.jsonObject) {
    messages.unshift({
      role: "system",
      content:
        "Respond with a single valid JSON object only. Do not wrap it in markdown code fences. Do not include any text before or after the JSON.",
    });
  }
  return messages;
}

function buildOpenAiBody(
  input: ClaudeChatInput,
  stream: boolean
): Record<string, unknown> {
  const model = resolveRequestModel(input);
  const modelCeiling = getClaudeMaxOutputTokens(model);
  const requested =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? input.maxTokens
      : modelCeiling;
  const maxTokens = Math.min(requested, modelCeiling);

  return {
    model,
    messages: buildOpenAiMessages(input),
    stream,
    // GPT-6 Luna: keep reasoning light so resume JSON starts quickly.
    reasoning_effort: "low",
    max_completion_tokens: maxTokens,
  };
}

function normalizeModelContent(raw: string, jsonObject: boolean): string {
  let text = String(raw || "").trim();
  if (!text) return "";
  if (jsonObject) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) text = fence[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  return text;
}

async function parseOpenAiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
      message?: string;
    };
    return (
      body.error?.message ||
      body.message ||
      `OpenAI HTTP ${response.status}`
    );
  } catch {
    return `OpenAI HTTP ${response.status}`;
  }
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

/**
 * Stream OpenAI Chat Completions text deltas (plain text) for resume / AI helpers.
 */
export async function streamOpenAiChatCompletion(
  input: ClaudeChatInput,
  onTextOrHandlers: ((text: string) => void) | OpenAiStreamChatHandlers
): Promise<void> {
  const handlers: OpenAiStreamChatHandlers =
    typeof onTextOrHandlers === "function"
      ? { onText: onTextOrHandlers }
      : onTextOrHandlers;

  if (aiMockEnabled) {
    handlers.onUpstreamReady?.();
    await streamMockChatCompletion(input, handlers.onText);
    return;
  }

  if (!openAiEnabled) {
    throw new Error("OpenAI API is not configured");
  }

  const overallAbort = new AbortController();
  const overallTimer = setTimeout(
    () => overallAbort.abort(),
    AI_REQUEST_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await raceWithTimeout(
      fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: openAiHeaders(),
        body: JSON.stringify(buildOpenAiBody(input, true)),
        signal: overallAbort.signal,
      }),
      AI_CONNECT_TIMEOUT_MS,
      `OpenAI upstream connect timeout after ${AI_CONNECT_TIMEOUT_MS}ms`
    );
  } catch (err) {
    clearTimeout(overallTimer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenAI request aborted after ${AI_REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  }

  if (!response.ok) {
    clearTimeout(overallTimer);
    throw new Error(await parseOpenAiError(response));
  }

  if (!response.body) {
    clearTimeout(overallTimer);
    throw new Error("OpenAI returned an empty stream");
  }

  handlers.onUpstreamReady?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      overallAbort.abort();
    }, AI_IDLE_TIMEOUT_MS);
  };
  bumpIdle();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bumpIdle();
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
            error?: { message?: string };
          };
          if (evt.error?.message) {
            throw new Error(evt.error.message);
          }
          const text = evt.choices?.[0]?.delta?.content;
          if (text) handlers.onText(text);
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

export async function createOpenAiChatCompletion(
  input: ClaudeChatInput
): Promise<{ content: string; model: string }> {
  if (aiMockEnabled) {
    return createMockChatCompletion(input);
  }

  let assembled = "";
  await streamOpenAiChatCompletion(input, (text) => {
    assembled += text;
  });

  const content = normalizeModelContent(assembled, input.jsonObject);
  if (!content) {
    throw new Error("OpenAI returned an empty response");
  }

  return { content, model: resolveRequestModel(input) };
}
