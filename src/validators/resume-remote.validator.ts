import { z } from "zod";

export const createRemoteDeviceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  setDefault: z.boolean().optional(),
});

export type CreateRemoteDeviceInput = z.infer<typeof createRemoteDeviceSchema>;

export const deliverArchiveSchema = z
  .object({
    mode: z.enum(["here", "remote"]),
    deviceId: z.string().uuid().optional(),
    includePdf: z.boolean().optional().default(true),
    includeDocx: z.boolean().optional().default(true),
  })
  .refine((value) => value.includePdf || value.includeDocx, {
    message: "At least one of includePdf or includeDocx must be true",
    path: ["includePdf"],
  })
  .refine(
    (value) => value.mode === "here" || value.deviceId === undefined || Boolean(value.deviceId),
    { message: "deviceId must be a valid uuid when provided", path: ["deviceId"] }
  );

export type DeliverArchiveInput = z.infer<typeof deliverArchiveSchema>;

export const ackRemoteDeliverySchema = z.object({
  status: z.enum(["delivered", "failed"]),
  error: z.string().trim().max(500).optional(),
});

export type AckRemoteDeliveryInput = z.infer<typeof ackRemoteDeliverySchema>;
