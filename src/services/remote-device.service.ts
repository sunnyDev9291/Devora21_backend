import { createHash, randomBytes } from "crypto";
import type { RemoteDevice } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";

export const REMOTE_DEVICE_SECRET_PREFIX = "dvrd_";

function hashDeviceSecret(rawSecret: string): string {
  return createHash("sha256").update(rawSecret).digest("hex");
}

function generateRawDeviceSecret(): string {
  return `${REMOTE_DEVICE_SECRET_PREFIX}${randomBytes(32).toString("hex")}`;
}

export type RemoteDevicePublic = {
  id: string;
  name: string;
  secretPrefix: string;
  isDefault: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
};

function toPublic(device: RemoteDevice): RemoteDevicePublic {
  return {
    id: device.id,
    name: device.name,
    secretPrefix: device.secretPrefix,
    isDefault: device.isDefault,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
    revokedAt: device.revokedAt?.toISOString() ?? null,
  };
}

export async function createRemoteDevice(
  userId: string,
  name: string,
  options?: { setDefault?: boolean }
): Promise<{ device: RemoteDevicePublic; rawSecret: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new AppError(400, "name is required");
  }
  if (trimmedName.length > 80) {
    throw new AppError(400, "name must be at most 80 characters");
  }

  const existingCount = await prisma.remoteDevice.count({
    where: { userId, revokedAt: null },
  });
  const setDefault =
    options?.setDefault === true || existingCount === 0;

  const rawSecret = generateRawDeviceSecret();
  const secretHash = hashDeviceSecret(rawSecret);
  const secretPrefix = rawSecret.slice(0, 12);

  const device = await prisma.$transaction(async (tx) => {
    if (setDefault) {
      await tx.remoteDevice.updateMany({
        where: { userId, revokedAt: null, isDefault: true },
        data: { isDefault: false },
      });
    }

    return tx.remoteDevice.create({
      data: {
        userId,
        name: trimmedName,
        secretPrefix,
        secretHash,
        isDefault: setDefault,
      },
    });
  });

  return { device: toPublic(device), rawSecret };
}

export async function listRemoteDevices(
  userId: string
): Promise<RemoteDevicePublic[]> {
  const devices = await prisma.remoteDevice.findMany({
    where: { userId, revokedAt: null },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
  });
  return devices.map(toPublic);
}

export async function setDefaultRemoteDevice(
  userId: string,
  deviceId: string
): Promise<RemoteDevicePublic> {
  const existing = await prisma.remoteDevice.findFirst({
    where: { id: deviceId, userId, revokedAt: null },
  });
  if (!existing) {
    throw new AppError(404, "Remote device not found");
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.remoteDevice.updateMany({
      where: { userId, revokedAt: null, isDefault: true },
      data: { isDefault: false },
    });
    return tx.remoteDevice.update({
      where: { id: deviceId },
      data: { isDefault: true },
    });
  });

  return toPublic(updated);
}

export async function revokeRemoteDevice(
  userId: string,
  deviceId: string
): Promise<RemoteDevicePublic> {
  const existing = await prisma.remoteDevice.findFirst({
    where: { id: deviceId, userId },
  });
  if (!existing) {
    throw new AppError(404, "Remote device not found");
  }
  if (existing.revokedAt) {
    return toPublic(existing);
  }

  const revoked = await prisma.$transaction(async (tx) => {
    const device = await tx.remoteDevice.update({
      where: { id: deviceId },
      data: { revokedAt: new Date(), isDefault: false },
    });

    if (existing.isDefault) {
      const next = await tx.remoteDevice.findFirst({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (next) {
        await tx.remoteDevice.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }

    return device;
  });

  return toPublic(revoked);
}

export async function findRemoteDeviceBySecret(
  rawSecret: string
): Promise<RemoteDevice | null> {
  if (!rawSecret.startsWith(REMOTE_DEVICE_SECRET_PREFIX)) {
    return null;
  }

  const secretHash = hashDeviceSecret(rawSecret);
  const device = await prisma.remoteDevice.findFirst({
    where: { secretHash, revokedAt: null },
  });
  if (!device) {
    return null;
  }

  await prisma.remoteDevice.update({
    where: { id: device.id },
    data: { lastSeenAt: new Date() },
  });

  return device;
}

export async function resolveRemoteDeviceForUser(
  userId: string,
  deviceId?: string
): Promise<RemoteDevice> {
  if (deviceId) {
    const device = await prisma.remoteDevice.findFirst({
      where: { id: deviceId, userId, revokedAt: null },
    });
    if (!device) {
      throw new AppError(404, "Remote device not found");
    }
    return device;
  }

  const preferred = await prisma.remoteDevice.findFirst({
    where: { userId, revokedAt: null, isDefault: true },
  });
  if (preferred) {
    return preferred;
  }

  const any = await prisma.remoteDevice.findFirst({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!any) {
    throw new AppError(
      422,
      "No remote device registered. Create one under remote devices first."
    );
  }
  return any;
}
