import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { zonedDayBoundsUtc } from "../lib/zoned-day";
import { publishApplicationCaptureEvent } from "../lib/application-capture-events";
import {
  backblazeEnabled,
  createBackblazeDownloadUrl,
  deleteBackblazeObjectByKey,
  uploadCaptureImageToBackblaze,
} from "./backblaze.service";
import type { CreateApplicationCaptureInput } from "../validators/application-capture.validator";

function parseCapturedAt(raw: unknown): Date {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 1e11) {
      const d = new Date(n);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Match extension normalizeCaptureUrl — one active session per user + URL. */
function normalizeCaptureUrl(url: string): string {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    return u.href;
  } catch {
    return String(url || "").trim();
  }
}

function decodeCaptureImageBase64(dataBase64: string): {
  buffer: Buffer;
  contentType: "image/jpeg" | "image/png";
  ext: "jpg" | "png";
} {
  const raw = String(dataBase64 || "").trim();
  const comma = raw.indexOf(",");
  const header =
    raw.startsWith("data:") && comma >= 0 ? raw.slice(0, comma).toLowerCase() : "";
  const b64 =
    raw.startsWith("data:") && comma >= 0 ? raw.slice(comma + 1) : raw;
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 100) {
    throw new AppError(400, "Invalid image payload");
  }
  if (buf.length > 6_000_000) {
    throw new AppError(400, "Screenshot too large (max ~6MB)");
  }
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47;
  if (isJpeg || header.includes("image/jpeg") || header.includes("image/jpg")) {
    return { buffer: buf, contentType: "image/jpeg", ext: "jpg" };
  }
  if (isPng || header.includes("image/png")) {
    return { buffer: buf, contentType: "image/png", ext: "png" };
  }
  throw new AppError(400, "Only JPEG or PNG screenshots are accepted");
}

type ImageRow = {
  id: string;
  sortOrder: number;
  storageKey: string;
  imageUrl: string;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  createdAt: Date;
  reviewed?: boolean;
  reviewedAt?: Date | null;
};

async function mapSession(
  session: {
    id: string;
    userId: string;
    clientCaptureId: string;
    tabUrl: string;
    pageTitle: string | null;
    status: string;
    sliceCount: number;
    errorMessage: string | null;
    capturedAt: Date;
    createdAt: Date;
    updatedAt: Date;
    images?: ImageRow[];
  },
  opts?: { signUrls?: boolean; uncheckedCount?: number }
) {
  const sign = opts?.signUrls !== false;
  const images = [];
  let uncheckedFromImages = 0;
  for (const img of session.images || []) {
    const reviewed = Boolean(img.reviewed);
    if (!reviewed) uncheckedFromImages += 1;
    let url = img.imageUrl;
    if (sign && img.imageUrl) {
      try {
        url = (await createBackblazeDownloadUrl(img.imageUrl)) || url;
      } catch {
        // keep stored url
      }
    }
    images.push({
      id: img.id,
      sortOrder: img.sortOrder,
      imageUrl: url,
      storageKey: img.storageKey,
      width: img.width,
      height: img.height,
      byteSize: img.byteSize,
      reviewed,
      reviewedAt: img.reviewedAt ? img.reviewedAt.toISOString() : null,
      createdAt: img.createdAt.toISOString(),
    });
  }
  images.sort((a, b) => a.sortOrder - b.sortOrder);

  const uncheckedCount =
    typeof opts?.uncheckedCount === "number"
      ? opts.uncheckedCount
      : // Only trust image-derived count when we loaded the full set (or empty).
        session.images
        ? uncheckedFromImages
        : 0;

  return {
    id: session.id,
    userId: session.userId,
    clientCaptureId: session.clientCaptureId,
    tabUrl: session.tabUrl,
    pageTitle: session.pageTitle,
    status: session.status,
    sliceCount: session.sliceCount,
    uncheckedCount,
    errorMessage: session.errorMessage,
    capturedAt: session.capturedAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    images,
  };
}

async function uncheckedCountsBySessionIds(
  sessionIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!sessionIds.length) return map;
  const rows = await prisma.applicationCaptureImage.groupBy({
    by: ["sessionId"],
    where: { sessionId: { in: sessionIds }, reviewed: false },
    _count: { _all: true },
  });
  for (const row of rows) {
    map.set(row.sessionId, row._count._all);
  }
  return map;
}

export async function createApplicationCapture(
  userId: string,
  input: CreateApplicationCaptureInput
) {
  if (!backblazeEnabled) {
    throw new AppError(
      503,
      "Cloud storage is not configured (Backblaze B2). Captures cannot be saved."
    );
  }

  const tabUrl = normalizeCaptureUrl(input.tabUrl);
  if (!tabUrl) {
    throw new AppError(400, "tabUrl is required");
  }

  const sessionInclude = {
    images: { orderBy: { sortOrder: "asc" as const } },
    user: {
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
      },
    },
  };

  // Idempotent: same clientCaptureId already uploaded → return as-is.
  const byClient = await prisma.applicationCaptureSession.findUnique({
    where: {
      userId_clientCaptureId: {
        userId,
        clientCaptureId: input.clientCaptureId,
      },
    },
    include: sessionInclude,
  });
  if (byClient && byClient.status === "uploaded") {
    const mapped = await mapSession(byClient);
    return {
      ok: true,
      created: false,
      session: {
        ...mapped,
        owner: {
          userId: byClient.user.id,
          email: byClient.user.email,
          name: ownerDisplayName(byClient.user),
        },
      },
    };
  }

  // One active session per user + URL: re-capture replaces items, not a new row.
  const byUrl = await prisma.applicationCaptureSession.findFirst({
    where: {
      userId,
      tabUrl,
      status: { not: "deleted" },
    },
    include: sessionInclude,
    orderBy: { capturedAt: "desc" },
  });

  const existing = byUrl || (byClient?.status !== "deleted" ? byClient : null);

  const sorted = [...input.images].sort((a, b) => a.sortOrder - b.sortOrder);
  // Stable B2 folder: reuse session id when updating; else clientCaptureId for create.
  const captureFolderId = existing?.id || input.clientCaptureId;
  const uploadedMeta: Array<{
    sortOrder: number;
    storageKey: string;
    imageUrl: string;
    width: number | null;
    height: number | null;
    byteSize: number;
  }> = [];

  try {
    for (const img of sorted) {
      const decoded = decodeCaptureImageBase64(img.dataBase64);
      const fileName = `slice-${String(img.sortOrder).padStart(2, "0")}.${decoded.ext}`;
      const up = await uploadCaptureImageToBackblaze({
        userId,
        captureId: captureFolderId,
        fileName,
        buffer: decoded.buffer,
        contentType: decoded.contentType,
      });
      uploadedMeta.push({
        sortOrder: img.sortOrder,
        storageKey: up.key,
        imageUrl: up.imageUrl,
        width: img.width ?? null,
        height: img.height ?? null,
        byteSize: decoded.buffer.length,
      });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      502,
      err instanceof Error ? err.message : "Failed to upload capture images"
    );
  }

  const imageCreates = uploadedMeta.map((m) => ({
    sortOrder: m.sortOrder,
    storageKey: m.storageKey,
    imageUrl: m.imageUrl,
    width: m.width,
    height: m.height,
    byteSize: m.byteSize,
    reviewed: false,
    reviewedAt: null as Date | null,
  }));

  let session;
  let created = false;

  if (existing) {
    let nextClientId = input.clientCaptureId;
    if (nextClientId !== existing.clientCaptureId) {
      const taken = await prisma.applicationCaptureSession.findUnique({
        where: {
          userId_clientCaptureId: {
            userId,
            clientCaptureId: nextClientId,
          },
        },
        select: { id: true },
      });
      if (taken && taken.id !== existing.id) {
        nextClientId = existing.clientCaptureId;
      }
    }

    const oldKeys = existing.images.map((img) => img.storageKey);
    session = await prisma.applicationCaptureSession.update({
      where: { id: existing.id },
      data: {
        clientCaptureId: nextClientId,
        tabUrl,
        pageTitle: input.pageTitle || null,
        status: "uploaded",
        sliceCount: uploadedMeta.length,
        errorMessage: null,
        capturedAt: parseCapturedAt(input.capturedAt),
        images: {
          deleteMany: {},
          create: imageCreates,
        },
      },
      include: sessionInclude,
    });
    // Best-effort cleanup of previous slices (ignore failures).
    await Promise.all(oldKeys.map((key) => deleteBackblazeObjectByKey(key)));
  } else {
    created = true;
    session = await prisma.applicationCaptureSession.create({
      data: {
        userId,
        clientCaptureId: input.clientCaptureId,
        tabUrl,
        pageTitle: input.pageTitle || null,
        status: "uploaded",
        sliceCount: uploadedMeta.length,
        capturedAt: parseCapturedAt(input.capturedAt),
        images: { create: imageCreates },
      },
      include: sessionInclude,
    });
  }

  const mapped = await mapSession(session);
  const withOwner = {
    ...mapped,
    owner: {
      userId: session.user.id,
      email: session.user.email,
      name: ownerDisplayName(session.user),
    },
  };
  publishApplicationCaptureEvent({
    type: created ? "session.created" : "session.updated",
    session: withOwner,
  });

  return {
    ok: true,
    created,
    session: withOwner,
  };
}

export async function listApplicationCaptures(
  userId: string,
  opts: { page?: number; limit?: number } = {}
) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 20));
  const where = { userId, status: { not: "deleted" } };

  const [total, rows] = await Promise.all([
    prisma.applicationCaptureSession.count({ where }),
    prisma.applicationCaptureSession.findMany({
      where,
      orderBy: { capturedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
      },
    }),
  ]);

  const sessions = [];
  for (const row of rows) {
    sessions.push(await mapSession(row));
  }

  return {
    sessions,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getApplicationCapture(userId: string, id: string) {
  const session = await prisma.applicationCaptureSession.findFirst({
    where: { id, userId, status: { not: "deleted" } },
    include: { images: { orderBy: { sortOrder: "asc" } } },
  });
  if (!session) throw new AppError(404, "Capture session not found");
  return { session: await mapSession(session) };
}

export async function deleteApplicationCapture(userId: string, id: string) {
  const session = await prisma.applicationCaptureSession.findFirst({
    where: { id, userId, status: { not: "deleted" } },
    select: { id: true, userId: true },
  });
  if (!session) throw new AppError(404, "Capture session not found");
  await prisma.applicationCaptureSession.update({
    where: { id: session.id },
    data: { status: "deleted" },
  });
  publishApplicationCaptureEvent({
    type: "session.deleted",
    sessionId: session.id,
    userId: session.userId,
  });
  return { ok: true };
}

/** Super Admin: users who have at least one non-deleted capture. */
export async function adminListCaptureOwners() {
  const grouped = await prisma.applicationCaptureSession.groupBy({
    by: ["userId"],
    where: { status: { not: "deleted" } },
    _count: { _all: true },
    _max: { capturedAt: true },
  });
  if (!grouped.length) return { owners: [] };

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.userId) } },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  // Sessions that still have ≥1 unchecked screenshot → badge count per profile.
  const uncheckedSessions = await prisma.applicationCaptureSession.findMany({
    where: {
      status: { not: "deleted" },
      images: { some: { reviewed: false } },
    },
    select: { id: true, userId: true },
  });
  const uncheckedSessionCountByUser = new Map<string, number>();
  for (const s of uncheckedSessions) {
    uncheckedSessionCountByUser.set(
      s.userId,
      (uncheckedSessionCountByUser.get(s.userId) || 0) + 1
    );
  }

  const owners = grouped
    .map((g) => {
      const u = byId.get(g.userId);
      const name =
        [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || null;
      return {
        userId: g.userId,
        email: u?.email || null,
        name,
        captureCount: g._count._all,
        /** Sessions with at least one unchecked screenshot. */
        uncheckedSessionCount: uncheckedSessionCountByUser.get(g.userId) || 0,
        lastCapturedAt: g._max.capturedAt?.toISOString() || null,
      };
    })
    .sort((a, b) => {
      const ta = a.lastCapturedAt ? Date.parse(a.lastCapturedAt) : 0;
      const tb = b.lastCapturedAt ? Date.parse(b.lastCapturedAt) : 0;
      return tb - ta;
    });

  return { owners };
}

function ownerDisplayName(u: {
  firstName: string | null;
  lastName: string | null;
}): string | null {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

/** Super Admin: list captures across users (optional userId / q / date filters). */
export async function adminListApplicationCaptures(opts: {
  userId?: string;
  q?: string;
  page?: number;
  limit?: number;
  /** Calendar day YYYY-MM-DD in `timezone` (filters `capturedAt`). */
  date?: string;
  timezone?: string;
} = {}) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const q = String(opts.q || "").trim();
  const day = String(opts.date || "").trim();
  const timezone = String(opts.timezone || "").trim() || "America/New_York";

  const where: {
    status: { not: string };
    userId?: string;
    capturedAt?: { gte: Date; lt: Date };
    OR?: Array<Record<string, unknown>>;
  } = { status: { not: "deleted" } };

  if (opts.userId) where.userId = opts.userId;
  if (day) {
    const { start, end } = zonedDayBoundsUtc(day, timezone);
    where.capturedAt = { gte: start, lt: end };
  }
  if (q) {
    where.OR = [
      { tabUrl: { contains: q, mode: "insensitive" } },
      { pageTitle: { contains: q, mode: "insensitive" } },
      { clientCaptureId: { contains: q, mode: "insensitive" } },
      { user: { email: { contains: q, mode: "insensitive" } } },
      { user: { firstName: { contains: q, mode: "insensitive" } } },
      { user: { lastName: { contains: q, mode: "insensitive" } } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.applicationCaptureSession.count({ where }),
    prisma.applicationCaptureSession.findMany({
      where,
      orderBy: { capturedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        images: { orderBy: { sortOrder: "asc" }, take: 1 },
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    }),
  ]);

  const uncheckedMap = await uncheckedCountsBySessionIds(rows.map((r) => r.id));

  const sessions = [];
  for (const row of rows) {
    const mapped = await mapSession(row, {
      uncheckedCount: uncheckedMap.get(row.id) || 0,
    });
    sessions.push({
      ...mapped,
      owner: {
        userId: row.user.id,
        email: row.user.email,
        name: ownerDisplayName(row.user),
      },
    });
  }

  return {
    sessions,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    ...(day ? { date: day, timezone } : {}),
  };
}

/** Super Admin: full session + all slices (any user). */
export async function adminGetApplicationCapture(id: string) {
  const session = await prisma.applicationCaptureSession.findFirst({
    where: { id, status: { not: "deleted" } },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });
  if (!session) throw new AppError(404, "Capture session not found");
  const mapped = await mapSession(session);
  return {
    session: {
      ...mapped,
      owner: {
        userId: session.user.id,
        email: session.user.email,
        name: ownerDisplayName(session.user),
      },
    },
  };
}

/** Super Admin: soft-delete URL session (+ best-effort B2 cleanup). */
export async function adminDeleteApplicationCapture(id: string) {
  const session = await prisma.applicationCaptureSession.findFirst({
    where: { id, status: { not: "deleted" } },
    include: {
      images: { select: { id: true, storageKey: true } },
    },
  });
  if (!session) throw new AppError(404, "Capture session not found");

  await prisma.applicationCaptureSession.update({
    where: { id: session.id },
    data: { status: "deleted" },
  });

  // Best-effort cloud cleanup (do not fail the API if B2 delete fails).
  await Promise.all(
    session.images.map((img) => deleteBackblazeObjectByKey(img.storageKey))
  );

  publishApplicationCaptureEvent({
    type: "session.deleted",
    sessionId: session.id,
    userId: session.userId,
  });
  return { ok: true, sessionId: session.id };
}

/**
 * Super Admin: delete one screenshot slice from a URL session.
 * If it was the last image, soft-deletes the session too.
 */
export async function adminDeleteApplicationCaptureImage(
  sessionId: string,
  imageId: string
) {
  const session = await prisma.applicationCaptureSession.findFirst({
    where: { id: sessionId, status: { not: "deleted" } },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });
  if (!session) throw new AppError(404, "Capture session not found");

  const image = session.images.find((img) => img.id === imageId);
  if (!image) throw new AppError(404, "Screenshot not found");

  await prisma.applicationCaptureImage.delete({ where: { id: image.id } });
  await deleteBackblazeObjectByKey(image.storageKey);

  const remaining = session.images.filter((img) => img.id !== image.id);

  if (remaining.length === 0) {
    await prisma.applicationCaptureSession.update({
      where: { id: session.id },
      data: { status: "deleted", sliceCount: 0 },
    });
    publishApplicationCaptureEvent({
      type: "image.deleted",
      sessionId: session.id,
      imageId: image.id,
      userId: session.userId,
      session: null,
    });
    publishApplicationCaptureEvent({
      type: "session.deleted",
      sessionId: session.id,
      userId: session.userId,
    });
    return {
      ok: true,
      sessionDeleted: true,
      sessionId: session.id,
      imageId: image.id,
      session: null,
    };
  }

  const updated = await prisma.applicationCaptureSession.update({
    where: { id: session.id },
    data: { sliceCount: remaining.length },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  const mapped = await mapSession(updated);
  const withOwner = {
    ...mapped,
    owner: {
      userId: updated.user.id,
      email: updated.user.email,
      name: ownerDisplayName(updated.user),
    },
  };

  publishApplicationCaptureEvent({
    type: "image.deleted",
    sessionId: session.id,
    imageId: image.id,
    userId: session.userId,
    session: withOwner,
  });
  publishApplicationCaptureEvent({
    type: "session.updated",
    session: withOwner,
  });

  return {
    ok: true,
    sessionDeleted: false,
    sessionId: session.id,
    imageId: image.id,
    session: withOwner,
  };
}

/**
 * Super Admin: mark a screenshot as reviewed/checked (first open/expand).
 * Idempotent if already reviewed.
 */
export async function adminMarkCaptureImageReviewed(
  sessionId: string,
  imageId: string
) {
  const session = await prisma.applicationCaptureSession.findFirst({
    where: { id: sessionId, status: { not: "deleted" } },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });
  if (!session) throw new AppError(404, "Capture session not found");

  const image = session.images.find((img) => img.id === imageId);
  if (!image) throw new AppError(404, "Screenshot not found");

  if (!image.reviewed) {
    await prisma.applicationCaptureImage.update({
      where: { id: image.id },
      data: { reviewed: true, reviewedAt: new Date() },
    });
  }

  const refreshed = await prisma.applicationCaptureSession.findFirst({
    where: { id: session.id },
    include: {
      images: { orderBy: { sortOrder: "asc" } },
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });
  if (!refreshed) throw new AppError(404, "Capture session not found");

  const mapped = await mapSession(refreshed);
  const withOwner = {
    ...mapped,
    owner: {
      userId: refreshed.user.id,
      email: refreshed.user.email,
      name: ownerDisplayName(refreshed.user),
    },
  };

  publishApplicationCaptureEvent({
    type: "image.reviewed",
    sessionId: session.id,
    imageId: image.id,
    userId: session.userId,
    session: withOwner,
  });
  publishApplicationCaptureEvent({
    type: "session.updated",
    session: withOwner,
  });

  return {
    ok: true,
    alreadyReviewed: Boolean(image.reviewed),
    sessionId: session.id,
    imageId: image.id,
    session: withOwner,
  };
}
