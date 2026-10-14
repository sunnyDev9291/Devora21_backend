import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { parseResumeTemplate } from "../lib/resume/parse-template";
import type { ResumeTemplateLayout } from "../lib/resume/types";
import { toPdfDisplayName } from "../utils/sanitize";
import { convertDocxBufferToPdf } from "./resume-convert.service";
import {
  deleteUserFile,
  readUserFile,
  resolveStoragePath,
  saveUserFile,
} from "./profile-storage.service";

export type ResumeTemplateStructure = {
  templateId: string;
  fileName: string;
  mode: "styled" | "legacy";
  layout: ResumeTemplateLayout;
  profileName: string;
  headerTitle: string;
  skillsSample: string;
  jobs: Array<{
    company: string;
    role: string;
    dates: string;
    bulletCount: number;
    /** Template bullet texts (slot order) — FE should show this count, not AI draft length. */
    bulletSamples: string[];
  }>;
};

export type StoredResumeTemplate = {
  templateId: string;
  fileName: string;
  storageKey: string;
  buffer: Buffer;
  contentHash?: string | null;
  updatedAt?: Date;
};

function newTemplateId(): string {
  return `tpl_${uuidv4().replace(/-/g, "")}`;
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\<>:"|?*\x00-\x1f]/g, "_").trim();
  return base.slice(0, 200) || "resume-template.docx";
}

function hashDocx(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertDocxBuffer(buffer: Buffer): void {
  if (!buffer || buffer.length < 1024) {
    throw new AppError(422, "Resume template must be a valid DOCX file");
  }
  // OOXML zip magic "PK"
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new AppError(422, "Resume template must be a valid DOCX file");
  }
  if (!buffer.includes(Buffer.from("word/document.xml"))) {
    throw new AppError(422, "Resume template must be a valid DOCX file");
  }
}

async function purgeTemplatePdfCaches(
  userId: string,
  templateIds: string[] = []
): Promise<void> {
  const dir = resolveStoragePath(`users/${userId}/templates`);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  const idSet = new Set(templateIds.filter(Boolean));
  await Promise.all(
    entries
      .filter((name) => {
        if (!name.endsWith(".pdf")) return false;
        if (idSet.size === 0) return true;
        return [...idSet].some((id) => name.startsWith(`${id}-`) || name.startsWith(`${id}.`));
      })
      .map((name) => fs.unlink(path.join(dir, name)).catch(() => undefined))
  );
}

/**
 * Persist an uploaded DOCX as the user's ACTIVE template.
 * Always allocates a NEW templateId and invalidates previous PDF caches.
 */
export async function storeUserResumeTemplate(input: {
  userId: string;
  fileName: string;
  buffer: Buffer;
  previousStorageKey?: string | null;
  /** Ignored on purpose — replace always gets a fresh id. */
  existingTemplateId?: string | null;
}): Promise<{
  resumeTemplateId: string;
  resumeTemplateKey: string;
  resumeTemplateFileName: string;
}> {
  assertDocxBuffer(input.buffer);

  const fileName = sanitizeFilename(input.fileName);
  const templateId = newTemplateId();
  const contentHash = hashDocx(input.buffer);

  const previousRows = await prisma.resumeTemplate.findMany({
    where: { userId: input.userId },
    select: { id: true, storageKey: true },
  });
  const previousIds = previousRows.map((r) => r.id);

  const storageKey = await saveUserFile(
    input.userId,
    `templates/${templateId}.docx`,
    input.buffer
  );

  // New active row
  await prisma.resumeTemplate.create({
    data: {
      id: templateId,
      userId: input.userId,
      fileName,
      storageKey,
      contentHash,
      isActive: true,
    },
  });

  // Deactivate + remove previous template rows/files
  if (previousIds.length > 0) {
    await prisma.resumeTemplate.updateMany({
      where: { userId: input.userId, id: { not: templateId } },
      data: { isActive: false },
    });

    await Promise.all(
      previousRows.map(async (row) => {
        if (row.storageKey && row.storageKey !== storageKey) {
          await deleteUserFile(row.storageKey);
        }
      })
    );

    // Keep DB lean: delete inactive rows for this user
    await prisma.resumeTemplate.deleteMany({
      where: { userId: input.userId, id: { not: templateId } },
    });
  }

  if (
    input.previousStorageKey &&
    input.previousStorageKey !== storageKey &&
    !previousRows.some((r) => r.storageKey === input.previousStorageKey)
  ) {
    await deleteUserFile(input.previousStorageKey);
  }

  await purgeTemplatePdfCaches(input.userId, [...previousIds, templateId]);

  await prisma.user.update({
    where: { id: input.userId },
    data: {
      resumeTemplateId: templateId,
      resumeTemplateKey: storageKey,
      resumeTemplateFileName: fileName,
    },
  });

  return {
    resumeTemplateId: templateId,
    resumeTemplateKey: storageKey,
    resumeTemplateFileName: fileName,
  };
}

/**
 * Ensure legacy users (key/fileName only) get a ResumeTemplate row + templateId.
 */
export async function ensureUserResumeTemplateId(
  userId: string
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      resumeTemplateId: true,
      resumeTemplateKey: true,
      resumeTemplateFileName: true,
    },
  });

  if (!user) {
    throw new AppError(404, "User not found");
  }

  if (user.resumeTemplateId) {
    const existing = await prisma.resumeTemplate.findFirst({
      where: { id: user.resumeTemplateId, userId },
      select: { id: true, isActive: true },
    });
    if (existing) {
      if (!existing.isActive) {
        await prisma.resumeTemplate.update({
          where: { id: existing.id },
          data: { isActive: true },
        });
      }
      return user.resumeTemplateId;
    }
  }

  // Prefer any active row if user pointer is stale
  const active = await prisma.resumeTemplate.findFirst({
    where: { userId, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (active) {
    await prisma.user.update({
      where: { id: userId },
      data: {
        resumeTemplateId: active.id,
        resumeTemplateKey: active.storageKey,
        resumeTemplateFileName: active.fileName,
      },
    });
    return active.id;
  }

  if (!user.resumeTemplateKey || !user.resumeTemplateFileName) {
    return null;
  }

  const templateId = user.resumeTemplateId?.trim() || newTemplateId();
  let contentHash: string | null = null;
  try {
    const buf = await readUserFile(user.resumeTemplateKey);
    contentHash = hashDocx(buf);
  } catch {
    // leave null if file missing
  }

  await prisma.resumeTemplate.upsert({
    where: { id: templateId },
    create: {
      id: templateId,
      userId,
      fileName: user.resumeTemplateFileName,
      storageKey: user.resumeTemplateKey,
      contentHash,
      isActive: true,
    },
    update: {
      fileName: user.resumeTemplateFileName,
      storageKey: user.resumeTemplateKey,
      contentHash,
      isActive: true,
    },
  });

  if (user.resumeTemplateId !== templateId) {
    await prisma.user.update({
      where: { id: userId },
      data: { resumeTemplateId: templateId },
    });
  }

  return templateId;
}

export async function loadResumeTemplateForUser(input: {
  userId: string;
  templateId?: string | null;
  /** When true (default for profile/pdf), only the active template is allowed. */
  requireActive?: boolean;
}): Promise<StoredResumeTemplate> {
  const requestedId = input.templateId?.trim() || null;
  const requireActive = input.requireActive !== false;

  if (requestedId) {
    const row = await prisma.resumeTemplate.findFirst({
      where: {
        id: requestedId,
        userId: input.userId,
        ...(requireActive ? { isActive: true } : {}),
      },
    });
    if (!row) {
      throw new AppError(404, "Resume template not found");
    }
    const buffer = await readUserFile(row.storageKey);
    return {
      templateId: row.id,
      fileName: row.fileName,
      storageKey: row.storageKey,
      buffer,
      contentHash: row.contentHash,
      updatedAt: row.updatedAt,
    };
  }

  const ensuredId = await ensureUserResumeTemplateId(input.userId);
  if (!ensuredId) {
    throw new AppError(404, "Resume template not found");
  }

  const row = await prisma.resumeTemplate.findFirst({
    where: { id: ensuredId, userId: input.userId },
  });
  if (!row) {
    throw new AppError(404, "Resume template not found");
  }

  const buffer = await readUserFile(row.storageKey);
  return {
    templateId: row.id,
    fileName: row.fileName,
    storageKey: row.storageKey,
    buffer,
    contentHash: row.contentHash,
    updatedAt: row.updatedAt,
  };
}

/** Authoritative Mode-1 skeleton: job headers + exact bullet slot counts from DOCX styles. */
export async function getResumeTemplateStructure(input: {
  userId: string;
  templateId?: string | null;
}): Promise<ResumeTemplateStructure> {
  const stored = await loadResumeTemplateForUser({
    userId: input.userId,
    templateId: input.templateId,
    requireActive: true,
  });
  const parsed = parseResumeTemplate(stored.buffer);
  return {
    templateId: stored.templateId,
    fileName: stored.fileName,
    mode: parsed.mode,
    layout: parsed.layout,
    profileName: parsed.profileName,
    headerTitle: parsed.headerTitle,
    skillsSample: parsed.skillsSample,
    jobs: parsed.jobs.map((j) => ({
      company: j.company,
      role: j.role,
      dates: j.dates,
      bulletCount: j.bulletCount,
      bulletSamples: j.bulletSamples ?? [],
    })),
  };
}

/**
 * Convert the user's original stored template DOCX → PDF as-is (no fill).
 * Cache key includes templateId + contentHash/updatedAt so replaces never reuse old PDFs.
 */
export async function getResumeTemplatePdf(input: {
  userId: string;
  templateId?: string | null;
}): Promise<{
  templateId: string;
  pdfFileName: string;
  buffer: Buffer;
}> {
  // Profile PDF always uses ACTIVE template. Explicit id must belong to user
  // and be active (replaced templates are deleted).
  const template = await loadResumeTemplateForUser({
    userId: input.userId,
    templateId: input.templateId,
    requireActive: true,
  });

  const row = await prisma.resumeTemplate.findFirst({
    where: { id: template.templateId, userId: input.userId },
    select: {
      id: true,
      fileName: true,
      updatedAt: true,
      contentHash: true,
      storageKey: true,
    },
  });
  if (!row) {
    throw new AppError(404, "Resume template not found");
  }

  const stamp = row.contentHash || String(row.updatedAt.getTime());
  const cacheRel = `templates/${row.id}-${stamp}.pdf`;
  const cacheKey = `users/${input.userId}/${cacheRel}`;
  const cachePath = resolveStoragePath(cacheKey);
  const pdfFileName = toPdfDisplayName(row.fileName);

  try {
    const cached = await fs.readFile(cachePath);
    if (cached.length > 100) {
      return { templateId: row.id, pdfFileName, buffer: cached };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  // Always convert from the live stored DOCX path (not a stale in-memory copy).
  const liveBuffer = await readUserFile(row.storageKey);

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await convertDocxBufferToPdf(liveBuffer);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message =
      err instanceof Error ? err.message : "Failed to convert template to PDF";
    throw new AppError(500, message);
  }

  // Drop any prior PDFs for this template id, then write the fresh cache entry.
  await purgeTemplatePdfCaches(input.userId, [row.id]);
  await saveUserFile(input.userId, cacheRel, pdfBuffer);

  return { templateId: row.id, pdfFileName, buffer: pdfBuffer };
}

/**
 * Persist a transitional templateBase64 upload as the user's active template.
 */
export async function persistTemplateBase64ForUser(input: {
  userId: string;
  templateBase64: string;
  templateFileName?: string | null;
}): Promise<StoredResumeTemplate> {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(input.templateBase64, "base64");
  } catch {
    throw new AppError(400, "templateBase64 is invalid");
  }

  assertDocxBuffer(buffer);

  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      resumeTemplateId: true,
      resumeTemplateKey: true,
    },
  });

  const saved = await storeUserResumeTemplate({
    userId: input.userId,
    fileName: input.templateFileName || "resume-template.docx",
    buffer,
    previousStorageKey: user?.resumeTemplateKey,
    existingTemplateId: user?.resumeTemplateId,
  });

  return {
    templateId: saved.resumeTemplateId,
    fileName: saved.resumeTemplateFileName,
    storageKey: saved.resumeTemplateKey,
    buffer,
  };
}
