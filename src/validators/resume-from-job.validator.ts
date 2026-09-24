import { z } from "zod";
import { truthyFlagSchema } from "../lib/truthy-flag";

/** Optional long writing-prompt override from the client. */
const optionalPromptOverride = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().max(50_000).optional());

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
    /** Ignored no-op kept for older clients that still send the skip flag. */
    skipEnglishTeamGate: truthyFlagSchema.optional().default(false),
    skip_english_team_gate: truthyFlagSchema.optional().default(false),
  })
  .transform((value) => ({
    url: value.url,
    customPrompt: value.customPrompt,
    profilePrompt: value.profilePrompt,
    promptContent: value.promptContent,
    skipEnglishTeamGate:
      value.skipEnglishTeamGate === true || value.skip_english_team_gate === true,
  }));

export type ResumeFromJobInput = z.infer<typeof resumeFromJobSchema>;
