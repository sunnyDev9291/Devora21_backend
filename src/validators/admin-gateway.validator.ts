import { z } from "zod";

const gatewayUsernameSchema = z
  .string()
  .trim()
  .min(3, "username must be at least 3 characters")
  .max(64, "username must be at most 64 characters")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "username may only contain letters, numbers, dots, underscores, and hyphens"
  );

const gatewayPasswordSchema = z
  .string()
  .min(8, "password must be at least 8 characters")
  .max(128, "password must be at most 128 characters");

export const putGatewayCredentialsSchema = z.object({
  username: gatewayUsernameSchema,
  password: gatewayPasswordSchema,
  /** Required only when credentials are already configured (enforced in service). */
  currentPassword: z.string().min(1).max(128).optional(),
});

export type PutGatewayCredentialsInput = z.infer<
  typeof putGatewayCredentialsSchema
>;

export const verifyGatewayCredentialsSchema = z.object({
  username: gatewayUsernameSchema,
  password: gatewayPasswordSchema,
});

export type VerifyGatewayCredentialsInput = z.infer<
  typeof verifyGatewayCredentialsSchema
>;
