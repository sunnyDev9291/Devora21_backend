import bcrypt from "bcrypt";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { logger } from "../lib/logger";
import type {
  PutGatewayCredentialsInput,
  VerifyGatewayCredentialsInput,
} from "../validators/admin-gateway.validator";

const SALT_ROUNDS = 12;

export type GatewayCredentialsStatus = {
  configured: boolean;
  username?: string;
};

function statusFromUser(user: {
  gatewayUsername: string | null;
  gatewayPasswordHash: string | null;
}): GatewayCredentialsStatus {
  const configured = Boolean(
    user.gatewayUsername?.trim() && user.gatewayPasswordHash
  );
  if (!configured) {
    return { configured: false };
  }
  return {
    configured: true,
    username: user.gatewayUsername!.trim(),
  };
}

export async function getGatewayCredentialsStatus(
  userId: string
): Promise<GatewayCredentialsStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      gatewayUsername: true,
      gatewayPasswordHash: true,
    },
  });
  if (!user) {
    throw new AppError(404, "User not found");
  }
  return statusFromUser(user);
}

export async function putGatewayCredentials(
  userId: string,
  input: PutGatewayCredentialsInput
): Promise<GatewayCredentialsStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      gatewayUsername: true,
      gatewayPasswordHash: true,
    },
  });
  if (!user) {
    throw new AppError(404, "User not found");
  }

  const alreadyConfigured = Boolean(
    user.gatewayUsername?.trim() && user.gatewayPasswordHash
  );

  if (alreadyConfigured) {
    const current = input.currentPassword;
    if (!current) {
      throw new AppError(400, "currentPassword is required to update gateway credentials");
    }
    const ok = await bcrypt.compare(current, user.gatewayPasswordHash!);
    if (!ok) {
      throw new AppError(401, "current password incorrect");
    }
  }

  const username = input.username.trim();
  const taken = await prisma.user.findFirst({
    where: {
      gatewayUsername: username,
      NOT: { id: userId },
    },
    select: { id: true },
  });
  if (taken) {
    throw new AppError(409, "Gateway username is already taken");
  }

  const gatewayPasswordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      gatewayUsername: username,
      gatewayPasswordHash,
      gatewayCredentialsSetAt: new Date(),
    },
    select: {
      gatewayUsername: true,
      gatewayPasswordHash: true,
    },
  });

  return statusFromUser(updated);
}

export async function verifyGatewayCredentials(
  userId: string,
  input: VerifyGatewayCredentialsInput
): Promise<{ ok: true }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      gatewayUsername: true,
      gatewayPasswordHash: true,
    },
  });
  if (!user) {
    throw new AppError(404, "User not found");
  }

  if (!user.gatewayUsername?.trim() || !user.gatewayPasswordHash) {
    throw new AppError(400, "Gateway credentials are not set.");
  }

  const usernameOk = input.username.trim() === user.gatewayUsername.trim();
  const passwordOk = usernameOk
    ? await bcrypt.compare(input.password, user.gatewayPasswordHash)
    : false;

  if (!usernameOk || !passwordOk) {
    logger.info("admin.gateway", "verify_failed", {
      userIdPresent: true,
      // Never log username/password values.
    });
    throw new AppError(401, "Invalid username or password.");
  }

  return { ok: true };
}
