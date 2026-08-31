import { z } from "zod";

export const resumeFromJobSchema = z.object({
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
});

export type ResumeFromJobInput = z.infer<typeof resumeFromJobSchema>;
