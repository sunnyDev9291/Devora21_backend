import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";

export type ClaudeModelFamily = "haiku" | "sonnet" | "opus";

export type ClaudeModelCatalogEntry = {
  id: string;
  label: string;
  family: ClaudeModelFamily;
  description: string;
  isDefault?: boolean;
};

/** Sole allowlisted model for resume + AI helpers. */
export const FALLBACK_DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";

/**
 * Server allowlist of Anthropic model ids the resume pipeline may call.
 * Only Haiku 5.5 is enabled.
 */
export const CLAUDE_MODEL_ALLOWLIST = ["claude-haiku-5-5"] as const;

export type AllowedClaudeModelId = (typeof CLAUDE_MODEL_ALLOWLIST)[number];

const ALLOWLIST_SET = new Set<string>(CLAUDE_MODEL_ALLOWLIST);

export const CLAUDE_MODEL_CATALOG: ClaudeModelCatalogEntry[] = [
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    family: "haiku",
    description: "Fast · resume drafting and extraction",
    isDefault: true,
  },
];

function envDefaultModel(): string {
  const fromEnv =
    env.RESUME_AI_MODEL?.trim() ||
    env.CLAUDE_DEFAULT_MODEL?.trim() ||
    "";
  if (fromEnv && ALLOWLIST_SET.has(fromEnv)) {
    return fromEnv;
  }
  return FALLBACK_DEFAULT_CLAUDE_MODEL;
}

/** Default model id used when the request omits `model`. */
export function getDefaultClaudeModel(): string {
  return envDefaultModel();
}

/** @deprecated Prefer getDefaultClaudeModel() — kept for server boot logs. */
export const CLAUDE_MODEL = getDefaultClaudeModel();

export function isAllowedClaudeModel(modelId: string): boolean {
  return ALLOWLIST_SET.has(modelId.trim());
}

/**
 * Resolve a request model id.
 * - missing / empty → default (claude-haiku-5-5 or env)
 * - unknown → 400 (never silently remap)
 */
export function resolveClaudeModel(raw?: string | null): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return getDefaultClaudeModel();
  }
  if (!isAllowedClaudeModel(trimmed)) {
    throw new AppError(400, `Unsupported Claude model: ${trimmed}`);
  }
  return trimmed;
}

/**
 * Models that accept Anthropic `thinking: { type: "between_tools" }`.
 * Haiku 5.5 rejects this parameter — only Sonnet/Opus 5.x support it.
 */
export function modelSupportsBetweenToolsThinking(modelId: string): boolean {
  return /claude-(?:sonnet|opus)-5(?:-\d+)?$/i.test(modelId.trim());
}

/**
 * Haiku 5.5 defaults to adaptive (hidden) thinking — tokens appear only after
 * that finishes. It accepts `thinking: { type: "disabled" }` at high effort
 * or below so visible text can stream immediately.
 */
export function modelSupportsDisabledThinking(modelId: string): boolean {
  return /claude-haiku-5(?:-\d+)?$/i.test(modelId.trim());
}

/**
 * Anthropic `thinking` body field for resume/chat: turn off up-front reasoning
 * so streamed JSON/text starts right away (no silent 30–60s delay).
 */
export function getClaudeThinkingConfig(
  modelId: string
): { type: "between_tools" } | { type: "disabled" } | undefined {
  if (modelSupportsBetweenToolsThinking(modelId)) {
    return { type: "between_tools" };
  }
  if (modelSupportsDisabledThinking(modelId)) {
    return { type: "disabled" };
  }
  return undefined;
}

/** Absolute max we ever request (Haiku 5.5 supports up to 128k). */
export const CLAUDE_MAX_OUTPUT_TOKENS_CEILING = 128_000;

/** Haiku 5.5 Anthropic output ceiling. */
export const CLAUDE_HAIKU_MAX_OUTPUT_TOKENS = 128_000;

/**
 * Per-model Anthropic max_tokens ceiling.
 */
export function getClaudeMaxOutputTokens(modelId: string): number {
  const id = modelId.trim().toLowerCase();
  if (id.includes("haiku")) {
    return CLAUDE_HAIKU_MAX_OUTPUT_TOKENS;
  }
  return CLAUDE_MAX_OUTPUT_TOKENS_CEILING;
}

export function listClaudeModelsResponse(): {
  defaultModelId: string;
  models: ClaudeModelCatalogEntry[];
} {
  const defaultModelId = getDefaultClaudeModel();
  const models = CLAUDE_MODEL_CATALOG.map((entry) => ({
    ...entry,
    isDefault: entry.id === defaultModelId,
  }));
  return { defaultModelId, models };
}
