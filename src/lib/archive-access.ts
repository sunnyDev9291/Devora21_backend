import { prisma } from "./prisma";
import { AppError } from "../middleware/errorHandler";
import { logger } from "./logger";

export type ArchiveAccessCaller = {
  userId: string;
  isSuperAdmin?: boolean;
};

/** Prisma where: Super Admin → by id only; otherwise owner-scoped. */
export function archiveAccessWhere(
  archiveId: string,
  caller: ArchiveAccessCaller
): { id: string; userId?: string } {
  const id = archiveId.trim();
  if (!id) {
    throw new AppError(400, "Archive id is required");
  }
  if (caller.isSuperAdmin) {
    return { id };
  }
  return { id, userId: caller.userId };
}

/**
 * Load an archive the caller may access.
 * Super Admin: any archive by id. Normal user: own archives only.
 * Always includes id + userId for ownership / audit.
 */
export async function findAccessibleArchive(
  archiveId: string,
  caller: ArchiveAccessCaller,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  select: Record<string, boolean>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const where = archiveAccessWhere(archiveId, caller);
  const row = await prisma.resumeArchive.findFirst({
    where,
    select: {
      id: true,
      userId: true,
      ...select,
    },
  });
  if (!row) {
    throw new AppError(404, "Resume archive not found");
  }
  return row;
}

export function auditArchiveAccess(input: {
  action: string;
  callerUserId: string;
  isSuperAdmin?: boolean;
  archiveId: string;
  ownerProfileId: string;
  meta?: Record<string, unknown>;
}): void {
  if (!input.isSuperAdmin || input.callerUserId === input.ownerProfileId) {
    return;
  }
  logger.info("admin.archive", input.action, {
    adminId: input.callerUserId,
    archiveId: input.archiveId,
    ownerProfileId: input.ownerProfileId,
    ...input.meta,
  });
}
