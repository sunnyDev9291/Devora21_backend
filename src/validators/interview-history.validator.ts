import { z } from "zod";

export const recordInterviewRoundSchema = z.object({
  /** "round" appends next Round N; "other" leaves history unchanged. */
  action: z.enum(["round", "other"]),
});

export type RecordInterviewRoundInput = z.infer<typeof recordInterviewRoundSchema>;

/** Optional body form: DELETE /interview-rounds with { round }. */
export const deleteInterviewRoundBodySchema = z.object({
  round: z.coerce.number().int().positive(),
});

export type DeleteInterviewRoundBodyInput = z.infer<
  typeof deleteInterviewRoundBodySchema
>;
