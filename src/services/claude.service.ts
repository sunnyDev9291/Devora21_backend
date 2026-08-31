import { env, aiMockEnabled } from "../config/env";
import type { ChatCompletionsInput } from "../validators/ai.validator";
import {
  createMockChatCompletion,
  streamMockChatCompletion,
} from "./mock-ai.service";

const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
export const CLAUDE_MODEL = "claude-sonnet-4-6";
/** Max synchronous output for claude-sonnet-4-6 (API hard cap; not truly unlimited). */
export const CLAUDE_MAX_OUTPUT_TOKENS = 64_000;
const AI_REQUEST_TIMEOUT_MS = 300_000;
const ANTHROPIC_VERSION = "2023-06-01";

interface ClaudeMessageResponse {
  error?: {
    message?: string;
  };
}

interface ClaudeStreamEvent {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
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

function splitMessages(input: ChatCompletionsInput): {
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

function buildClaudeBody(input: ChatCompletionsInput, stream: boolean): Record<string, unknown> {
  const { system, messages } = splitMessages(input);

  const body: Record<string, unknown> = {
    model: CLAUDE_MODEL,
    max_tokens: input.maxTokens,
    messages,
    stream,
  };

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
  input: ChatCompletionsInput
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

  return { content, model: CLAUDE_MODEL };
}

/**
 * Streams raw AI text chunks (plain text) from Claude's streaming API.
 * Caller writes these directly to the HTTP response body.
 */
export async function streamChatCompletion(
  input: ChatCompletionsInput,
  onText: (text: string) => void
): Promise<void> {
  if (aiMockEnabled) {
    await streamMockChatCompletion(input, onText);
    return;
  }

  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: claudeHeaders(),
    body: JSON.stringify(buildClaudeBody(input, true)),
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(await parseClaudeError(response));
  }

  if (!response.body) {
    throw new Error("Claude returned an empty stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

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

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const text = event.delta.text;
          if (text) {
            onText(text);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
