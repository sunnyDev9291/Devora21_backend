import { z } from "zod";
import { truthyFlagSchema } from "../lib/truthy-flag";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

/** Payload accepted by Claude create/stream helpers (no resume-gate fields). */
export type ClaudeChatInput = {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  maxTokens: number;
  jsonObject: boolean;
};

const optionalTrimmedString = z.preprocess((value) => {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return value;
  return value.trim();
}, z.string());

export const chatCompletionsSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1, "messages is required"),
    maxTokens: z
      .number()
      .int()
      .positive()
      .max(64_000)
      .optional()
      .default(64_000),
    jsonObject: z.boolean().optional().default(false),
    /**
     * BFF / internal-key only: which user's profile prompt to apply.
     * Ignored when the request already has a session / user API key.
     */
    userId: z.string().trim().uuid().optional(),
    jobTitle: optionalTrimmedString.optional().default(""),
    job_title: optionalTrimmedString.optional().default(""),
    jobDescription: optionalTrimmedString.optional().default(""),
    job_description: optionalTrimmedString.optional().default(""),
    /** User confirmed "Continue creating" after ENGLISH_TEAM_REQUIRED. */
    skipEnglishTeamGate: truthyFlagSchema.optional().default(false),
    skip_english_team_gate: truthyFlagSchema.optional().default(false),
  })
  .transform((value) => {
    const jobTitle = value.jobTitle || value.job_title || "";
    const jobDescription = value.jobDescription || value.job_description || "";
    const skipEnglishTeamGate =
      value.skipEnglishTeamGate === true || value.skip_english_team_gate === true;
    return {
      messages: value.messages,
      maxTokens: value.maxTokens,
      jsonObject: value.jsonObject,
      userId: value.userId,
      jobTitle,
      jobDescription,
      skipEnglishTeamGate,
    };
  })
  .refine(
    (value) => value.jobTitle.length > 0 || value.jobDescription.length > 0,
    {
      message: "jobTitle or jobDescription is required for resume generation",
      path: ["jobTitle"],
    }
  );

export type ChatCompletionsInput = z.infer<typeof chatCompletionsSchema>;
