import { z } from "zod";
import { truthyFlagSchema } from "../lib/truthy-flag";

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
    /** User confirmed "Continue creating" after ENGLISH_TEAM_REQUIRED. */
    skipEnglishTeamGate: truthyFlagSchema.optional().default(false),
    skip_english_team_gate: truthyFlagSchema.optional().default(false),
  })
  .transform((value) => ({
    url: value.url,
    skipEnglishTeamGate:
      value.skipEnglishTeamGate === true || value.skip_english_team_gate === true,
  }));

export type ResumeFromJobInput = z.infer<typeof resumeFromJobSchema>;
