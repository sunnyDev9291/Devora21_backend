import { z } from "zod";

const rrwebEventSchema = z
  .object({
    type: z.union([z.number(), z.string()]),
    data: z.unknown().optional(),
    timestamp: z.number().optional(),
  })
  .passthrough();

const frameChunkSchema = z.object({
  /** Stable key: e.g. "top" or "iframe:<origin><pathname>" */
  frameKey: z.string().trim().min(1).max(500),
  href: z.string().trim().max(4000).optional(),
  isTop: z.boolean().optional(),
  events: z.array(rrwebEventSchema).min(1).max(5000),
});

export const startRrwebSessionSchema = z.object({
  clientSessionId: z.string().trim().min(8).max(120),
  primaryUrl: z.string().trim().url().max(4000),
  pageTitle: z.string().trim().max(500).optional(),
  startedAt: z.union([z.string(), z.number()]).optional(),
});

export const appendRrwebEventsSchema = z.object({
  frames: z.array(frameChunkSchema).min(1).max(40),
});

export const completeRrwebSessionSchema = z.object({
  endedAt: z.union([z.string(), z.number()]).optional(),
  pageTitle: z.string().trim().max(500).optional(),
  primaryUrl: z.string().trim().url().max(4000).optional(),
  /** Optional final event flush in the same request. */
  frames: z.array(frameChunkSchema).max(40).optional(),
});

export type StartRrwebSessionInput = z.infer<typeof startRrwebSessionSchema>;
export type AppendRrwebEventsInput = z.infer<typeof appendRrwebEventsSchema>;
export type CompleteRrwebSessionInput = z.infer<
  typeof completeRrwebSessionSchema
>;
