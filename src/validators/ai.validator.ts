import { z } from "zod";

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

export const chatCompletionsSchema = z.object({
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
});

export type ChatCompletionsInput = z.infer<typeof chatCompletionsSchema>;
