import { createHash, randomBytes } from "crypto";
import type { ApiKey, User } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";

export const API_KEY_PREFIX = "dv21_";

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

function generateRawApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("hex")}`;
}

export type ApiKeyPublic = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
};

function toPublic(key: ApiKey): ApiKeyPublic {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    lastUsedAt: key.lastUsedAt,
    createdAt: key.createdAt,
    revokedAt: key.revokedAt,
  };
}

export async function createApiKey(
  userId: string,
  name: string
): Promise<{ apiKey: ApiKeyPublic; rawKey: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new AppError(400, "name is required");
  }

  const rawKey = generateRawApiKey();
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = rawKey.slice(0, 12);

  const apiKey = await prisma.apiKey.create({
    data: {
      userId,
      name: trimmedName,
      keyPrefix,
      keyHash,
    },
  });

  return { apiKey: toPublic(apiKey), rawKey };
}

export async function listApiKeys(userId: string): Promise<ApiKeyPublic[]> {
  const keys = await prisma.apiKey.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  return keys.map(toPublic);
}

export async function revokeApiKey(userId: string, keyId: string): Promise<ApiKeyPublic> {
  const existing = await prisma.apiKey.findFirst({
    where: { id: keyId, userId },
  });

  if (!existing) {
    throw new AppError(404, "API key not found");
  }

  if (existing.revokedAt) {
    return toPublic(existing);
  }

  const revoked = await prisma.apiKey.update({
    where: { id: keyId },
    data: { revokedAt: new Date() },
  });

  return toPublic(revoked);
}

export async function findUserByApiKey(rawKey: string): Promise<User | null> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const keyHash = hashApiKey(rawKey);
  const apiKey = await prisma.apiKey.findFirst({
    where: { keyHash, revokedAt: null },
    include: { user: true },
  });

  if (!apiKey) {
    return null;
  }

  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  });

  return apiKey.user;
}
