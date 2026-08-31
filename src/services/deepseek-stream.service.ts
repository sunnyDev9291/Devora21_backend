import { env, aiMockEnabled, deepseekEnabled } from "../config/env";

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEEPSEEK_TIMEOUT_MS = 120_000;

export type DeepSeekChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DeepSeekStreamInput = {
  messages: DeepSeekChatMessage[];
  maxTokens?: number;
};

type DeepSeekStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

async function parseDeepSeekError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as DeepSeekStreamChunk & {
      error?: { message?: string };
    };
    if (data.error?.message) {
      return data.error.message;
    }
  } catch {
    // fall through
  }
  return `DeepSeek request failed (${response.status})`;
}

async function streamMockDeepSeek(
  input: DeepSeekStreamInput,
  onText: (text: string) => void
): Promise<void> {
  const company =
    input.messages
      .find((m) => m.role === "user")
      ?.content.match(/Employer company name:\s*(.+)/)?.[1]
      ?.trim() || "the company";

  const content = [
    `Verdict: PARTIAL FIT (mock)`,
    ``,
    `${company} — mock Job Check via DeepSeek.`,
    `Working language and USD pay were not fully verified in mock mode.`,
    `Enable real DeepSeek (AI_MOCK=false) for a live analysis.`,
  ].join("\n");

  const chunkSize = 48;
  for (let i = 0; i < content.length; i += chunkSize) {
    onText(content.slice(i, i + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * Streams plain-text assistant tokens from DeepSeek (OpenAI-compatible SSE).
 * Same response style as Claude Job Check: raw text chunks for the HTTP body.
 */
export async function streamDeepSeekChatCompletion(
  input: DeepSeekStreamInput,
  onText: (text: string) => void
): Promise<void> {
  if (aiMockEnabled) {
    await streamMockDeepSeek(input, onText);
    return;
  }

  if (!deepseekEnabled) {
    throw new Error("DeepSeek API is not configured");
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY!}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: input.messages,
      max_tokens: input.maxTokens ?? 4096,
      stream: true,
    }),
    signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(await parseDeepSeekError(response));
  }

  if (!response.body) {
    throw new Error("DeepSeek returned an empty stream");
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

        let chunk: DeepSeekStreamChunk;
        try {
          chunk = JSON.parse(payload) as DeepSeekStreamChunk;
        } catch {
          continue;
        }

        if (chunk.error?.message) {
          throw new Error(chunk.error.message);
        }

        const text = chunk.choices?.[0]?.delta?.content;
        if (text) {
          onText(text);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
