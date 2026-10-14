import fs from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  emailVerificationRequired,
  isSuperAdminUser,
  superAdminEmails,
} from "../config/env";
import { toSafeUser, type SafeUser } from "./auth.service";
import {
  parseAdminProfileBody,
  updateUserProfile,
  getUserPrompt,
  getUserResumeTemplate,
  type ProfileMultipartInput,
} from "./onboarding.service";
import { invalidatePromptCache } from "../lib/resume/prompt-cache";
import { resolveStoragePath } from "./profile-storage.service";

export type AdminUserListItem = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
  emailVerified: boolean;
  onboardingCompleted: boolean;
  resumeBuilderEnabled: boolean;
  createdAt: string;
};

export type AdminUserListResult = {
  users: AdminUserListItem[];
  total: number;
  page: number;
  limit: number;
};

function displayName(
  firstName: string | null,
  lastName: string | null,
  email: string
): string {
  const parts = [firstName, lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return email.split("@")[0] ?? email;
}

export async function listUsers(input: {
  q?: string;
  page?: number;
  limit?: number;
}): Promise<AdminUserListResult> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 25)));
  const skip = (page - 1) * limit;
  const q = input.q?.trim() ?? "";

  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
        ],
      }
    : {};

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        emailVerified: true,
        onboardingCompleted: true,
        resumeBuilderEnabled: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      name: displayName(u.firstName, u.lastName, u.email),
      emailVerified: emailVerificationRequired ? u.emailVerified : true,
      onboardingCompleted: u.onboardingCompleted,
      resumeBuilderEnabled: u.resumeBuilderEnabled,
      createdAt: u.createdAt.toISOString(),
    })),
    total,
    page,
    limit,
  };
}

export async function getAdminUser(userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(404, "User not found");
  }
  return toSafeUser(user);
}

export async function updateAdminUser(
  userId: string,
  body: Record<string, unknown>,
  files: ProfileMultipartInput["files"]
): Promise<SafeUser> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    throw new AppError(404, "User not found");
  }

  const parsed = parseAdminProfileBody(body);
  return updateUserProfile(userId, {
    ...parsed,
    files,
  });
}

export async function getAdminUserPrompt(userId: string) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "User not found");
  }
  const prompt = await getUserPrompt(userId);
  return { content: prompt.content, fileName: prompt.fileName };
}

export async function getAdminUserResumeTemplate(userId: string) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "User not found");
  }
  const template = await getUserResumeTemplate(userId);
  return {
    fileName: template.fileName,
    templateId: template.templateId,
    templateBase64: template.templateBase64,
  };
}

/** Original stored template DOCX → PDF (LibreOffice), same pipeline as /auth/profile/resume-template/pdf. */
export async function getAdminUserResumeTemplatePdf(
  userId: string,
  templateId?: string | null
): Promise<{
  templateId: string;
  pdfFileName: string;
  buffer: Buffer;
}> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!existing) {
    throw new AppError(404, "User not found");
  }

  const { getResumeTemplatePdf } = await import("./resume-template.service");
  return getResumeTemplatePdf({ userId, templateId });
}

/** Dedicated prompt text save (optional alternative to PATCH customPrompt). */
export async function putAdminUserPrompt(
  userId: string,
  input: { content: string; fileName?: string }
): Promise<{ content: string; fileName: string }> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, promptFileName: true },
  });
  if (!existing) {
    throw new AppError(404, "User not found");
  }

  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!content) {
    throw new AppError(400, "content is required");
  }

  const fileName =
    (input.fileName?.trim() || existing.promptFileName || "prompt.txt").slice(0, 200);

  await prisma.user.update({
    where: { id: userId },
    data: {
      customPrompt: content,
      promptFileName: fileName,
    },
  });
  invalidatePromptCache(userId);

  return { content, fileName };
}

async function countSuperAdminUsers(excludeUserId?: string): Promise<number> {
  const emailList = [...superAdminEmails];
  const where: Prisma.UserWhereInput = {
    OR: [
      { isSuperAdmin: true },
      ...(emailList.length > 0
        ? [{ email: { in: emailList, mode: "insensitive" as const } }]
        : []),
    ],
  };
  if (excludeUserId) {
    where.NOT = { id: excludeUserId };
  }
  return prisma.user.count({ where });
}

/**
 * Permanently delete a user and cascade DB relations (archives, templates, tokens, etc.).
 * Also removes local storage under users/{id}/. Backblaze archive objects may remain orphaned.
 */
export async function deleteAdminUser(
  userId: string,
  actorUserId: string
): Promise<{ ok: true; id: string }> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    throw new AppError(404, "User not found");
  }

  if (userId === actorUserId) {
    throw new AppError(400, "Cannot delete your own Super Admin account");
  }

  if (isSuperAdminUser(existing)) {
    const remaining = await countSuperAdminUsers(userId);
    if (remaining < 1) {
      throw new AppError(409, "Cannot delete the last Super Admin");
    }
  }

  // DB cascade removes ResumeArchive / ResumeTemplate / tokens / API keys / devices.
  await prisma.user.delete({ where: { id: userId } });
  invalidatePromptCache(userId);

  // Best-effort local disk cleanup (avatar, template DOCX, prompt, PDF caches).
  const userDir = resolveStoragePath(`users/${userId}`);
  try {
    await fs.rm(userDir, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Non-fatal: account is already gone from the DB.
      console.warn(`Failed to remove storage for deleted user ${userId}:`, err);
    }
  }

  return { ok: true, id: userId };
}
