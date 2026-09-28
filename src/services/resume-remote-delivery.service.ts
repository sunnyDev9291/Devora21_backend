import type { ResumeRemoteDelivery } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { AppError } from "../middleware/errorHandler";
import { logger } from "../lib/logger";
import { createBackblazeDownloadUrl } from "./backblaze.service";
import { buildPublicShareUrl } from "./resume-archive.service";
import { resolveRemoteDeviceForUser } from "./remote-device.service";

const DELIVERY_TTL_MS = 48 * 60 * 60 * 1000;

export type DeliveryStatus =
  | "pending"
  | "claimed"
  | "delivered"
  | "failed"
  | "expired";

export type DeliveryPublic = {
  deliveryId: string;
  deviceId: string;
  deviceName?: string;
  deviceLastSeenAt?: string | null;
  archiveId: string;
  jobTitle?: string;
  companyName?: string;
  resumeFileName?: string;
  pdfFileName?: string;
  status: DeliveryStatus;
  /** Short UI copy for the current status. */
  message: string;
  /** true when FE can stop polling. */
  isTerminal: boolean;
  /** true only when status === delivered. */
  isSuccess: boolean;
  includePdf: boolean;
  includeDocx: boolean;
  error: string | null;
  claimedAt: string | null;
  deliveredAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt?: string;
};

const STATUS_MESSAGE: Record<DeliveryStatus, string> = {
  pending: "Queued — waiting for the remote computer agent to pick up",
  claimed: "Remote agent is downloading the file(s)",
  delivered: "Delivered to the remote computer",
  failed: "Delivery failed on the remote computer",
  expired: "Delivery expired before the remote agent picked it up",
};

function isTerminalStatus(status: DeliveryStatus): boolean {
  return status === "delivered" || status === "failed" || status === "expired";
}

export type HereDeliverResult = {
  mode: "here";
  archiveId: string;
  resumeFileName: string;
  pdfFileName: string;
  /** Same-origin API URLs — use with session/API auth (avoids B2 browser CORS). */
  pdfUrl?: string;
  docxUrl?: string;
};

export type RemoteDeliverResult = {
  mode: "remote";
  deliveryId: string;
  deviceId: string;
  deviceName: string;
  archiveId: string;
  status: DeliveryStatus;
  message: string;
  isTerminal: boolean;
  isSuccess: boolean;
  expiresAt: string;
};

export type RemoteQueueItem = {
  deliveryId: string;
  archiveId: string;
  status: DeliveryStatus;
  jobTitle: string;
  companyName: string;
  resumeFileName: string;
  pdfFileName: string;
  includePdf: boolean;
  includeDocx: boolean;
  pdfUrl?: string;
  docxUrl?: string;
  createdAt: string;
  expiresAt: string;
};

/** Browser "here" downloads must hit our API (cookies/Bearer), not Backblaze directly. */
function buildAuthenticatedArchiveUrl(
  archiveId: string,
  kind: "pdf" | "docx"
): string {
  return `${env.API_BASE_URL.replace(/\/$/, "")}/resume/archives/${archiveId}/${kind}`;
}

async function signedUrlsForArchive(archive: {
  id: string;
  pdfUrl: string | null;
  docxUrl: string | null;
  includePdf: boolean;
  includeDocx: boolean;
}): Promise<{ pdfUrl?: string; docxUrl?: string }> {
  const out: { pdfUrl?: string; docxUrl?: string } = {};

  if (archive.includePdf && archive.pdfUrl) {
    try {
      out.pdfUrl = await createBackblazeDownloadUrl(archive.pdfUrl);
    } catch {
      out.pdfUrl = buildPublicShareUrl(archive.id, "pdf");
    }
  }

  if (archive.includeDocx && archive.docxUrl) {
    try {
      out.docxUrl = await createBackblazeDownloadUrl(archive.docxUrl);
    } catch {
      out.docxUrl = buildPublicShareUrl(archive.id, "docx");
    }
  }

  return out;
}

function toDeliveryPublic(
  row: ResumeRemoteDelivery & {
    device?: { name?: string; lastSeenAt?: Date | null };
    archive?: {
      jobTitle?: string;
      companyName?: string;
      resumeFileName?: string;
      pdfFileName?: string;
    };
    updatedAt?: Date;
  },
  deviceName?: string
): DeliveryPublic {
  const status = row.status as DeliveryStatus;
  const name = deviceName || row.device?.name;
  return {
    deliveryId: row.id,
    deviceId: row.deviceId,
    ...(name ? { deviceName: name } : {}),
    deviceLastSeenAt: row.device?.lastSeenAt
      ? row.device.lastSeenAt.toISOString()
      : null,
    archiveId: row.archiveId,
    ...(row.archive?.jobTitle ? { jobTitle: row.archive.jobTitle } : {}),
    ...(row.archive?.companyName ? { companyName: row.archive.companyName } : {}),
    ...(row.archive?.resumeFileName
      ? { resumeFileName: row.archive.resumeFileName }
      : {}),
    ...(row.archive?.pdfFileName ? { pdfFileName: row.archive.pdfFileName } : {}),
    status,
    message:
      status === "failed" && row.error
        ? `${STATUS_MESSAGE.failed}: ${row.error}`
        : STATUS_MESSAGE[status] || status,
    isTerminal: isTerminalStatus(status),
    isSuccess: status === "delivered",
    includePdf: row.includePdf,
    includeDocx: row.includeDocx,
    error: row.error,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
  };
}

export async function deliverArchiveHere(
  userId: string,
  archiveId: string,
  options?: { includePdf?: boolean; includeDocx?: boolean }
): Promise<HereDeliverResult> {
  const includePdf = options?.includePdf !== false;
  const includeDocx = options?.includeDocx !== false;

  const archive = await prisma.resumeArchive.findFirst({
    where: { id: archiveId, userId },
  });
  if (!archive) {
    throw new AppError(404, "Resume archive not found");
  }

  // Do NOT return Backblaze signed URLs here — browser fetch() hits CORS ("Failed to fetch").
  // Authenticated same-origin archive routes stream the file with the user's session/API key.
  const urls: { pdfUrl?: string; docxUrl?: string } = {};
  if (includePdf && archive.pdfUrl) {
    urls.pdfUrl = buildAuthenticatedArchiveUrl(archive.id, "pdf");
  }
  if (includeDocx && archive.docxUrl) {
    urls.docxUrl = buildAuthenticatedArchiveUrl(archive.id, "docx");
  }

  if (!urls.pdfUrl && !urls.docxUrl) {
    throw new AppError(404, "No downloadable files on this archive");
  }

  logger.info("remote.deliver", "here download urls issued", {
    userId,
    archiveId: archive.id,
    includePdf,
    includeDocx,
    pdfUrl: Boolean(urls.pdfUrl),
    docxUrl: Boolean(urls.docxUrl),
  });

  return {
    mode: "here",
    archiveId: archive.id,
    resumeFileName: archive.resumeFileName,
    pdfFileName: archive.pdfFileName,
    ...urls,
  };
}

export async function enqueueRemoteDelivery(
  userId: string,
  archiveId: string,
  options?: {
    deviceId?: string;
    includePdf?: boolean;
    includeDocx?: boolean;
  }
): Promise<RemoteDeliverResult> {
  const includePdf = options?.includePdf !== false;
  const includeDocx = options?.includeDocx !== false;
  if (!includePdf && !includeDocx) {
    throw new AppError(400, "At least one of includePdf or includeDocx is required");
  }

  const archive = await prisma.resumeArchive.findFirst({
    where: { id: archiveId, userId },
    select: { id: true, pdfUrl: true, docxUrl: true },
  });
  if (!archive) {
    throw new AppError(404, "Resume archive not found");
  }
  if (includePdf && !archive.pdfUrl) {
    throw new AppError(404, "PDF not available on this archive");
  }
  if (includeDocx && !archive.docxUrl) {
    throw new AppError(404, "DOCX not available on this archive");
  }

  const device = await resolveRemoteDeviceForUser(userId, options?.deviceId);
  const expiresAt = new Date(Date.now() + DELIVERY_TTL_MS);

  const delivery = await prisma.resumeRemoteDelivery.create({
    data: {
      userId,
      deviceId: device.id,
      archiveId: archive.id,
      status: "pending",
      includePdf,
      includeDocx,
      expiresAt,
    },
  });

  logger.info("remote.deliver", "queued remote delivery", {
    userId,
    archiveId: archive.id,
    deliveryId: delivery.id,
    deviceId: device.id,
    deviceName: device.name,
    includePdf,
    includeDocx,
    expiresAt: expiresAt.toISOString(),
  });

  return {
    mode: "remote",
    deliveryId: delivery.id,
    deviceId: device.id,
    deviceName: device.name,
    archiveId: archive.id,
    status: "pending",
    message: STATUS_MESSAGE.pending,
    isTerminal: false,
    isSuccess: false,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function getDeliveryForUser(
  userId: string,
  deliveryId: string
): Promise<DeliveryPublic> {
  // Mark expired before reading so FE sees accurate terminal state.
  await prisma.resumeRemoteDelivery.updateMany({
    where: {
      id: deliveryId,
      userId,
      status: { in: ["pending", "claimed"] },
      expiresAt: { lt: new Date() },
    },
    data: { status: "expired" },
  });

  const row = await prisma.resumeRemoteDelivery.findFirst({
    where: { id: deliveryId, userId },
    include: {
      device: { select: { name: true, lastSeenAt: true } },
      archive: {
        select: {
          jobTitle: true,
          companyName: true,
          resumeFileName: true,
          pdfFileName: true,
        },
      },
    },
  });
  if (!row) {
    throw new AppError(404, "Delivery not found");
  }
  return toDeliveryPublic(row, row.device.name);
}

export async function listDeliveriesForUser(
  userId: string,
  options?: { archiveId?: string; limit?: number }
): Promise<DeliveryPublic[]> {
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100);

  await prisma.resumeRemoteDelivery.updateMany({
    where: {
      userId,
      status: { in: ["pending", "claimed"] },
      expiresAt: { lt: new Date() },
      ...(options?.archiveId ? { archiveId: options.archiveId } : {}),
    },
    data: { status: "expired" },
  });

  const rows = await prisma.resumeRemoteDelivery.findMany({
    where: {
      userId,
      ...(options?.archiveId ? { archiveId: options.archiveId } : {}),
    },
    include: {
      device: { select: { name: true, lastSeenAt: true } },
      archive: {
        select: {
          jobTitle: true,
          companyName: true,
          resumeFileName: true,
          pdfFileName: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((row) => toDeliveryPublic(row, row.device.name));
}

/** Expire stale pending/claimed rows for a device, then claim pending ones. */
export async function pullRemoteQueueForDevice(
  deviceId: string,
  userId: string,
  limit = 10
): Promise<RemoteQueueItem[]> {
  const now = new Date();

  await prisma.resumeRemoteDelivery.updateMany({
    where: {
      deviceId,
      status: { in: ["pending", "claimed"] },
      expiresAt: { lt: now },
    },
    data: { status: "expired" },
  });

  const pending = await prisma.resumeRemoteDelivery.findMany({
    where: {
      deviceId,
      userId,
      status: "pending",
      expiresAt: { gt: now },
    },
    include: {
      archive: {
        select: {
          id: true,
          jobTitle: true,
          companyName: true,
          resumeFileName: true,
          pdfFileName: true,
          pdfUrl: true,
          docxUrl: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 50),
  });

  if (pending.length === 0) {
    return [];
  }

  const ids = pending.map((row) => row.id);
  await prisma.resumeRemoteDelivery.updateMany({
    where: { id: { in: ids }, status: "pending" },
    data: { status: "claimed", claimedAt: now },
  });

  logger.info("remote.queue", "agent claimed deliveries", {
    deviceId,
    userId,
    count: ids.length,
    deliveryIds: ids,
  });

  const items: RemoteQueueItem[] = [];
  for (const row of pending) {
    const urls = await signedUrlsForArchive({
      id: row.archive.id,
      pdfUrl: row.archive.pdfUrl,
      docxUrl: row.archive.docxUrl,
      includePdf: row.includePdf,
      includeDocx: row.includeDocx,
    });

    items.push({
      deliveryId: row.id,
      archiveId: row.archiveId,
      status: "claimed",
      jobTitle: row.archive.jobTitle,
      companyName: row.archive.companyName,
      resumeFileName: row.archive.resumeFileName,
      pdfFileName: row.archive.pdfFileName,
      includePdf: row.includePdf,
      includeDocx: row.includeDocx,
      ...urls,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    });
  }

  return items;
}

export async function ackRemoteDelivery(
  deviceId: string,
  deliveryId: string,
  input: { status: "delivered" | "failed"; error?: string }
) {
  const row = await prisma.resumeRemoteDelivery.findFirst({
    where: { id: deliveryId, deviceId },
  });
  if (!row) {
    throw new AppError(404, "Delivery not found");
  }

  if (row.status === "delivered" || row.status === "failed") {
    return toDeliveryPublic(row);
  }

  if (row.status === "expired") {
    throw new AppError(409, "Delivery already expired");
  }

  const updated = await prisma.resumeRemoteDelivery.update({
    where: { id: deliveryId },
    data: {
      status: input.status,
      error:
        input.status === "failed"
          ? (input.error?.trim() || "Delivery failed").slice(0, 500)
          : null,
      deliveredAt: input.status === "delivered" ? new Date() : null,
    },
  });

  logger.info("remote.queue", `agent ack ${input.status}`, {
    deviceId,
    deliveryId,
    status: input.status,
    ...(input.status === "failed" ? { error: updated.error } : {}),
  });

  return toDeliveryPublic(updated);
}
