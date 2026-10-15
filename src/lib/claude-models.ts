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

/** Canonical default — must match FE (`claude-sonnet-4-6`). */
export const FALLBACK_DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";

/**
 * Server allowlist of Anthropic model ids the resume pipeline may call.
 * Add new versions here and to CLAUDE_MODEL_CATALOG when enabling them.
 */
export const CLAUDE_MODEL_ALLOWLIST = [
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-5",
  "claude-opus-4-6",
] as const;

export type AllowedClaudeModelId = (typeof CLAUDE_MODEL_ALLOWLIST)[number];

const ALLOWLIST_SET = new Set<string>(CLAUDE_MODEL_ALLOWLIST);

export const CLAUDE_MODEL_CATALOG: ClaudeModelCatalogEntry[] = [
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    family: "haiku",
    description: "Fastest · lower cost",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    family: "sonnet",
    description: "Balanced quality and speed",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    family: "sonnet",
    description: "Recommended for resume drafting",
    isDefault: true,
  },
  {
    id: "claude-opus-4-5",
    label: "Opus 4.5",
    family: "opus",
    description: "Highest quality · slower",
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    family: "opus",
    description: "Highest quality · slower",
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
 * - missing / empty → default (claude-sonnet-4-6 or env)
 * - unknown → 400 (never silently remap to another family)
 */
export function resolveClaudeModel(
  raw?: string | null
): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return getDefaultClaudeModel();
  }
  if (!isAllowedClaudeModel(trimmed)) {
    throw new AppError(400, `Unsupported Claude model: ${trimmed}`);
  }
  return trimmed;
}

/** Models that accept Anthropic `thinking: { type: "between_tools" }`. */
export function modelSupportsBetweenToolsThinking(modelId: string): boolean {
  // Sonnet 5.5+ style ids; 4.x allowlisted models reject or ignore this.
  return /claude-(?:sonnet|opus|haiku)-5(?:-\d+)?$/i.test(modelId.trim());
}

/** Absolute max we ever request (supported on Sonnet/Opus 4.x+). */
export const CLAUDE_MAX_OUTPUT_TOKENS_CEILING = 128_000;

/** Haiku 4.5 Anthropic output ceiling. */
export const CLAUDE_HAIKU_MAX_OUTPUT_TOKENS = 64_000;

/**
 * Per-model Anthropic max_tokens ceiling.
 * Requesting above the model limit returns 400 (e.g. Haiku 4.5 → 64k).
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
