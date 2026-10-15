import { z } from "zod";
import { truthyFlagSchema } from "../lib/truthy-flag";

/** Optional long writing-prompt override from the client. */
const optionalPromptOverride = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().max(50_000).optional());

/** Optional Anthropic model id (validated against allowlist in the service). */
const optionalModelId = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).max(120).optional());

export const resumeFromJobSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1, "url is required")
      .url("url must be a valid URL")
      .refine((value) => {
        try {
          const protocol = new URL(value).protocol;
          return protocol === "http:" || protocol === "https:";
        } catch {
          return false;
        }
      }, "url must use http or https"),
    /** Fresh writing prompt from frontend (preferred over profile store). */
    customPrompt: optionalPromptOverride,
    profilePrompt: optionalPromptOverride,
    promptContent: optionalPromptOverride,
    /** Anthropic model for all AI steps in this job. Omit → server default. */
    model: optionalModelId,
    model_id: optionalModelId,
    modelId: optionalModelId,
    /** Ignored no-op kept for older clients that still send the skip flag. */
    skipEnglishTeamGate: truthyFlagSchema.optional().default(false),
    skip_english_team_gate: truthyFlagSchema.optional().default(false),
  })
  .transform((value) => ({
    url: value.url,
    customPrompt: value.customPrompt,
    profilePrompt: value.profilePrompt,
    promptContent: value.promptContent,
    model: value.model || value.model_id || value.modelId,
    skipEnglishTeamGate:
      value.skipEnglishTeamGate === true || value.skip_english_team_gate === true,
  }));

export type ResumeFromJobInput = z.infer<typeof resumeFromJobSchema>;
