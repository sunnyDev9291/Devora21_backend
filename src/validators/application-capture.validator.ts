import { z } from "zod";

const captureImageSchema = z.object({
  /** 0-based order top → bottom */
  sortOrder: z.coerce.number().int().min(0).max(40),
  /**
   * data:image/jpeg;base64,... or raw base64.
   * Full-page PNG pastes are large — allow up to ~8MB of base64 text
   * (~6MB decoded); service still enforces a decoded byte cap.
   */
  dataBase64: z.string().min(32).max(8_000_000),
  width: z.coerce.number().int().positive().max(4000).optional(),
  height: z.coerce.number().int().positive().max(20_000).optional(),
});

export const createApplicationCaptureSchema = z.object({
  clientCaptureId: z.string().trim().min(8).max(120),
  tabUrl: z.string().trim().url().max(4000),
  pageTitle: z.string().trim().max(500).optional(),
  capturedAt: z.union([z.string(), z.number()]).optional(),
  images: z.array(captureImageSchema).min(1).max(25),
});

export type CreateApplicationCaptureInput = z.infer<
  typeof createApplicationCaptureSchema
>;
