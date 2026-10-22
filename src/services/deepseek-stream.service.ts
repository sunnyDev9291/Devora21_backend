import { aiMockEnabled, claudeEnabled } from "../config/env";
import { getDefaultClaudeModel } from "../lib/claude-models";
import { streamChatCompletion } from "./claude.service";

/** @deprecated Alias — streaming now uses Claude Haiku 5.5. */
export const DEEPSEEK_MODEL = getDefaultClaudeModel();

export type DeepSeekChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type DeepSeekStreamInput = {
  messages: DeepSeekChatMessage[];
  maxTokens?: number;
};

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
    `${company} — mock Job Check via Claude Haiku 5.5.`,
    `Working language and USD pay were not fully verified in mock mode.`,
    `Enable real Claude (AI_MOCK=false) for a live analysis.`,
  ].join("\n");

  const chunkSize = 48;
  for (let i = 0; i < content.length; i += chunkSize) {
    onText(content.slice(i, i + chunkSize));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/**
 * Streams plain-text assistant tokens via Claude Haiku 5.5.
 * Export name kept for callers; no longer calls DeepSeek.
 */
export async function streamDeepSeekChatCompletion(
  input: DeepSeekStreamInput,
  onText: (text: string) => void
): Promise<void> {
  if (aiMockEnabled) {
    await streamMockDeepSeek(input, onText);
    return;
  }

  if (!claudeEnabled) {
    throw new Error("Claude API is not configured");
  }

  await streamChatCompletion(
    {
      model: getDefaultClaudeModel(),
      messages: input.messages,
      maxTokens: input.maxTokens ?? 4096,
      jsonObject: false,
    },
    onText
  );
}
