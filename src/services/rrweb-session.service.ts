import { gzipSync, gunzipSync } from "zlib";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { zonedDayBoundsUtc } from "../lib/zoned-day";
import { publishRrwebSessionEvent } from "../lib/rrweb-session-events";
import {
  backblazeEnabled,
  createBackblazePresignedGetUrl,
  deleteBackblazeObjectByKey,
  downloadBackblazeFileByUrl,
  openBackblazeReadStream,
  uploadRrwebEventsToBackblaze,
} from "./backblaze.service";
import type {
  AppendRrwebEventsInput,
  CompleteRrwebSessionInput,
  StartRrwebSessionInput,
} from "../validators/rrweb-session.validator";

type StoredFrame = {
  frameKey: string;
  href?: string;
  isTop?: boolean;
  events: unknown[];
};

type StoredPayload = {
  version: 1;
  clientSessionId: string;
  /** Optional: hints for FE replay (skipInactive recommended). */
  optimized?: boolean;
  frames: StoredFrame[];
};

function isGzipBuffer(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

function decodeStoredPayload(
  buf: Buffer,
  clientSessionId: string
): StoredPayload {
  const text = (
    isGzipBuffer(buf) ? gunzipSync(buf) : buf
  ).toString("utf8");
  const parsed = JSON.parse(text) as StoredPayload;
  if (!parsed || !Array.isArray(parsed.frames)) {
    return emptyPayload(clientSessionId);
  }
  return {
    version: 1,
    clientSessionId: parsed.clientSessionId || clientSessionId,
    optimized: Boolean(parsed.optimized),
    frames: parsed.frames.map((f) => ({
      frameKey: String(f.frameKey || "unknown"),
      href: f.href,
      isTop: f.isTop,
      events: Array.isArray(f.events) ? f.events : [],
    })),
  };
}

function encodeStoredPayload(payload: StoredPayload): Buffer {
  const json = Buffer.from(
    JSON.stringify({ ...payload, optimized: true, version: 1 }),
    "utf8"
  );
  return gzipSync(json, { level: 6 });
}

function parseInstant(raw: unknown): Date {
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

function normalizePrimaryUrl(url: string): string {
  try {
    const u = new URL(String(url || "").trim());
    u.hash = "";
    return u.href;
  } catch {
    return String(url || "").trim();
  }
}

function emptyPayload(clientSessionId: string): StoredPayload {
  return { version: 1, clientSessionId, frames: [] };
}

function mergeFrames(
  existing: StoredPayload,
  chunks: AppendRrwebEventsInput["frames"]
): StoredPayload {
  const byKey = new Map<string, StoredFrame>();
  for (const f of existing.frames) {
    byKey.set(f.frameKey, {
      frameKey: f.frameKey,
      href: f.href,
      isTop: f.isTop,
      events: Array.isArray(f.events) ? f.events.slice() : [],
    });
  }
  for (const chunk of chunks) {
    const key = chunk.frameKey;
    const prev = byKey.get(key) || {
      frameKey: key,
      href: chunk.href,
      isTop: chunk.isTop,
      events: [],
    };
    if (chunk.href) prev.href = chunk.href;
    if (typeof chunk.isTop === "boolean") prev.isTop = chunk.isTop;
    prev.events.push(...chunk.events);
    byKey.set(key, prev);
  }
  return {
    version: 1,
    clientSessionId: existing.clientSessionId,
    frames: Array.from(byKey.values()),
  };
}

function countEvents(payload: StoredPayload): number {
  return payload.frames.reduce((n, f) => n + (f.events?.length || 0), 0);
}

/**
 * rrweb-player duration ≈ lastEvent.timestamp − firstEvent.timestamp.
 * Wall-clock (endedAt − startedAt) is often longer (idle pause, hidden tab, gaps).
 */
function eventTimelineMs(payload: StoredPayload): number | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const frame of payload.frames) {
    for (const ev of frame.events || []) {
      const t =
        ev && typeof ev === "object" && "timestamp" in ev
          ? Number((ev as { timestamp?: unknown }).timestamp)
          : NaN;
      if (!Number.isFinite(t)) continue;
      if (t < min) min = t;
      if (t > max) max = t;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  return Math.max(0, Math.round(max - min));
}

async function loadPayload(session: {
  clientSessionId: string;
  eventsUrl: string | null;
}): Promise<StoredPayload> {
  if (!session.eventsUrl) {
    return emptyPayload(session.clientSessionId);
  }
  try {
    const buf = await downloadBackblazeFileByUrl(session.eventsUrl);
    return decodeStoredPayload(buf, session.clientSessionId);
  } catch {
    return emptyPayload(session.clientSessionId);
  }
}

async function persistPayload(
  userId: string,
  sessionId: string,
  payload: StoredPayload
): Promise<{
  storageKey: string;
  eventsUrl: string;
  eventCount: number;
  frameCount: number;
  byteSize: number;
}> {
  if (!backblazeEnabled) {
    throw new AppError(503, "Backblaze B2 is not configured");
  }
  const buffer = encodeStoredPayload(payload);
  // Cap compressed size (~25MB compressed ≈ large session).
  if (buffer.length > 25_000_000) {
    throw new AppError(413, "rrweb session payload too large");
  }
  const uploaded = await uploadRrwebEventsToBackblaze({
    userId,
    sessionId,
    buffer,
    gzip: true,
  });
  return {
    storageKey: uploaded.key,
    eventsUrl: uploaded.eventsUrl,
    eventCount: countEvents(payload),
    frameCount: payload.frames.length,
    byteSize: buffer.length,
  };
}

async function mapSession(
  session: {
    id: string;
    userId: string;
    clientSessionId: string;
    primaryUrl: string;
    pageTitle: string | null;
    status: string;
    eventCount: number;
    durationMs: number | null;
    frameCount: number;
    storageKey: string | null;
    eventsUrl: string | null;
    reviewed: boolean;
    reviewedAt: Date | null;
    startedAt: Date;
    endedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    user?: {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
    } | null;
  },
  opts?: { signUrl?: boolean; includeEvents?: boolean }
) {
  let eventsUrl = session.eventsUrl;
  if (opts?.signUrl !== false && session.eventsUrl) {
    try {
      // S3 presigned GET — browser can pull directly from B2 (after bucket CORS).
      eventsUrl =
        (await createBackblazePresignedGetUrl(session.eventsUrl)) || eventsUrl;
    } catch {
      // keep stored
    }
  }

  // Default: do NOT embed events in API (fast open). FE fetches eventsUrl.
  let events: StoredPayload | null = null;
  if (opts?.includeEvents && session.eventsUrl) {
    events = await loadPayload(session);
  }

  const eventsEncoding =
    session.storageKey?.endsWith(".gz") ||
    session.eventsUrl?.includes(".json.gz")
      ? "gzip"
      : session.eventsUrl
        ? "json"
        : null;

  const owner = session.user
    ? {
        id: session.user.id,
        email: session.user.email,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        name:
          [session.user.firstName, session.user.lastName]
            .filter(Boolean)
            .join(" ")
            .trim() || null,
      }
    : undefined;

  return {
    id: session.id,
    userId: session.userId,
    clientSessionId: session.clientSessionId,
    primaryUrl: session.primaryUrl,
    pageTitle: session.pageTitle,
    status: session.status,
    eventCount: session.eventCount,
    durationMs: session.durationMs,
    frameCount: session.frameCount,
    storageKey: session.storageKey,
    eventsUrl,
    /**
     * Same-origin proxy fallback if browser CORS to B2 fails.
     * Prefer signed `eventsUrl` first (faster — one hop to B2).
     */
    eventsPath: session.eventsUrl
      ? `/admin/rrweb-sessions/${session.id}/events`
      : null,
    /** gzip | json | null — FE should fetch eventsUrl, not expect inline events. */
    eventsEncoding,
    /**
     * Uploaded: always replayable when eventsUrl exists.
     * Recording: replayable with partial data if events already flushed to B2.
     */
    replayable: Boolean(
      session.eventsUrl &&
        session.eventCount > 0 &&
        (session.status === "uploaded" || session.status === "recording")
    ),
    /**
     * Replay UX contract for Super Admin:
     * - preferDirectEventsUrl: fetch signed eventsUrl in the browser (no API hop)
     * - eventsPath: fallback if B2 CORS / Failed to fetch
     * - preferTopFrame / lazyIframeFrames / playOneFrameAtATime as before
     */
    replayHints: {
      skipInactive: true,
      preferTopFrame: true,
      lazyIframeFrames: true,
      playOneFrameAtATime: true,
      preferDirectEventsUrl: true,
      /** Full-color TV — do not apply grayscale filter on the player. */
      grayscaleOk: false,
      /** Live/partial replay OK while status=recording if eventsUrl present. */
      liveReplay: session.status === "recording",
    },
    reviewed: Boolean(session.reviewed),
    reviewedAt: session.reviewedAt ? session.reviewedAt.toISOString() : null,
    startedAt: session.startedAt.toISOString(),
    endedAt: session.endedAt ? session.endedAt.toISOString() : null,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    ...(owner ? { user: owner } : {}),
    ...(events ? { events } : {}),
  };
}

export async function startRrwebSession(
  userId: string,
  input: StartRrwebSessionInput
) {
  const clientSessionId = input.clientSessionId.trim();
  const primaryUrl = normalizePrimaryUrl(input.primaryUrl);
  const startedAt = parseInstant(input.startedAt);
  const pageTitle = input.pageTitle?.trim() || null;

  const existing = await prisma.rrwebSession.findUnique({
    where: {
      userId_clientSessionId: { userId, clientSessionId },
    },
  });

  if (existing && existing.status !== "deleted") {
    const updated = await prisma.rrwebSession.update({
      where: { id: existing.id },
      data: {
        primaryUrl: existing.primaryUrl || primaryUrl,
        pageTitle: pageTitle || existing.pageTitle,
        status: existing.status === "uploaded" ? existing.status : "recording",
      },
    });
    const mapped = await mapSession(updated);
    publishRrwebSessionEvent({ type: "session.updated", session: mapped });
    return { created: false, session: mapped };
  }

  const created = await prisma.rrwebSession.create({
    data: {
      userId,
      clientSessionId,
      primaryUrl,
      pageTitle,
      status: "recording",
      startedAt,
    },
  });

  const mapped = await mapSession(created);
  publishRrwebSessionEvent({ type: "session.created", session: mapped });
  return { created: true, session: mapped };
}

export async function appendRrwebEvents(
  userId: string,
  sessionId: string,
  input: AppendRrwebEventsInput
) {
  const session = await prisma.rrwebSession.findFirst({
    where: { id: sessionId, userId, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");

  const current = await loadPayload(session);
  const merged = mergeFrames(current, input.frames);
  const persisted = await persistPayload(userId, session.id, merged);
  const timelineMs = eventTimelineMs(merged);

  // Drop legacy uncompressed object when migrating to .json.gz
  if (
    session.storageKey &&
    session.storageKey !== persisted.storageKey
  ) {
    await deleteBackblazeObjectByKey(session.storageKey);
  }

  const updated = await prisma.rrwebSession.update({
    where: { id: session.id },
    data: {
      storageKey: persisted.storageKey,
      eventsUrl: persisted.eventsUrl,
      eventCount: persisted.eventCount,
      frameCount: persisted.frameCount,
      status: session.status === "uploaded" ? "uploaded" : "recording",
      ...(timelineMs != null ? { durationMs: timelineMs } : {}),
    },
  });

  const mapped = await mapSession(updated);
  publishRrwebSessionEvent({ type: "session.updated", session: mapped });
  return { ok: true, session: mapped };
}

export async function completeRrwebSession(
  userId: string,
  sessionId: string,
  input: CompleteRrwebSessionInput
) {
  const session = await prisma.rrwebSession.findFirst({
    where: { id: sessionId, userId, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");

  let eventCount = session.eventCount;
  let frameCount = session.frameCount;
  let storageKey = session.storageKey;
  let eventsUrl = session.eventsUrl;
  let payloadForDuration: StoredPayload | null = null;

  if (input.frames?.length) {
    const current = await loadPayload(session);
    const merged = mergeFrames(current, input.frames);
    const persisted = await persistPayload(userId, session.id, merged);
    eventCount = persisted.eventCount;
    frameCount = persisted.frameCount;
    storageKey = persisted.storageKey;
    eventsUrl = persisted.eventsUrl;
    payloadForDuration = merged;
  } else if (session.eventsUrl) {
    payloadForDuration = await loadPayload(session);
  }

  const endedAt = parseInstant(input.endedAt);
  const wallMs = Math.max(
    0,
    endedAt.getTime() - session.startedAt.getTime()
  );
  // Prefer event timeline so list duration matches rrweb-player (not wall clock).
  const timelineMs = payloadForDuration
    ? eventTimelineMs(payloadForDuration)
    : null;
  const durationMs = timelineMs != null ? timelineMs : wallMs;

  const updated = await prisma.rrwebSession.update({
    where: { id: session.id },
    data: {
      status: "uploaded",
      endedAt,
      durationMs,
      eventCount,
      frameCount,
      storageKey,
      eventsUrl,
      pageTitle: input.pageTitle?.trim() || session.pageTitle,
      primaryUrl: input.primaryUrl
        ? normalizePrimaryUrl(input.primaryUrl)
        : session.primaryUrl,
    },
  });

  const mapped = await mapSession(updated);
  publishRrwebSessionEvent({ type: "session.updated", session: mapped });
  return { ok: true, session: mapped };
}

export async function listOwnRrwebSessions(
  userId: string,
  opts: { page?: number; limit?: number } = {}
) {
  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 20));
  const where = { userId, status: { not: "deleted" } };
  const [total, rows] = await Promise.all([
    prisma.rrwebSession.count({ where }),
    prisma.rrwebSession.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  const sessions = [];
  for (const row of rows) {
    sessions.push(await mapSession(row));
  }
  return { sessions, total, page, limit };
}

export async function getOwnRrwebSession(
  userId: string,
  id: string,
  opts?: { includeEvents?: boolean }
) {
  const session = await prisma.rrwebSession.findFirst({
    where: { id, userId, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");
  return mapSession(session, {
    includeEvents: Boolean(opts?.includeEvents),
  });
}

export async function deleteOwnRrwebSession(userId: string, id: string) {
  const session = await prisma.rrwebSession.findFirst({
    where: { id, userId, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");
  if (session.storageKey) {
    await deleteBackblazeObjectByKey(session.storageKey);
  }
  await prisma.rrwebSession.update({
    where: { id: session.id },
    data: {
      status: "deleted",
      eventsUrl: null,
      storageKey: null,
      eventCount: 0,
      frameCount: 0,
    },
  });
  publishRrwebSessionEvent({
    type: "session.deleted",
    sessionId: session.id,
    userId: session.userId,
  });
  return { ok: true, id: session.id };
}

/**
 * If the extension missed POST /complete (SW killed, network blip), sessions
 * stay status=recording forever and the admin UI keeps the Recording badge.
 * Live tabs heart beat every ~20s; anything idle longer than this is finished.
 */
const STALE_RECORDING_MS = 90_000;

async function finalizeStaleRecordingSessions(opts?: {
  userId?: string;
  id?: string;
}) {
  const cutoff = new Date(Date.now() - STALE_RECORDING_MS);
  const where: {
    status: string;
    updatedAt: { lt: Date };
    userId?: string;
    id?: string;
  } = {
    status: "recording",
    updatedAt: { lt: cutoff },
  };
  if (opts?.userId) where.userId = opts.userId;
  if (opts?.id) where.id = opts.id;

  const stale = await prisma.rrwebSession.findMany({
    where,
    take: 100,
  });
  for (const session of stale) {
    const endedAt = session.updatedAt;
    const durationMs = Math.max(
      0,
      endedAt.getTime() - session.startedAt.getTime()
    );
    const updated = await prisma.rrwebSession.update({
      where: { id: session.id },
      data: {
        status: "uploaded",
        endedAt: session.endedAt || endedAt,
        durationMs: session.durationMs ?? durationMs,
      },
    });
    const mapped = await mapSession(updated);
    publishRrwebSessionEvent({ type: "session.updated", session: mapped });
  }
}

export async function adminListRrwebOwners() {
  await finalizeStaleRecordingSessions();

  const grouped = await prisma.rrwebSession.groupBy({
    by: ["userId"],
    where: { status: { not: "deleted" } },
    _count: { _all: true },
    _max: { startedAt: true },
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

  const owners = grouped
    .map((g) => {
      const u = byId.get(g.userId);
      const name =
        [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || null;
      return {
        userId: g.userId,
        email: u?.email || null,
        name,
        sessionCount: g._count._all,
        /** Unchecked/review badge removed — always 0; do not show a count pill. */
        uncheckedCount: 0,
        lastStartedAt: g._max.startedAt
          ? g._max.startedAt.toISOString()
          : null,
      };
    })
    .sort((a, b) => {
      const ta = a.lastStartedAt ? Date.parse(a.lastStartedAt) : 0;
      const tb = b.lastStartedAt ? Date.parse(b.lastStartedAt) : 0;
      return tb - ta;
    });

  return { owners };
}

export async function adminListRrwebSessions(opts: {
  userId?: string;
  q?: string;
  date?: string;
  timezone?: string;
  page?: number;
  limit?: number;
}) {
  await finalizeStaleRecordingSessions(
    opts.userId ? { userId: opts.userId } : undefined
  );

  const page = Math.max(1, opts.page || 1);
  const limit = Math.min(100, Math.max(1, opts.limit || 25));
  const where: Record<string, unknown> = { status: { not: "deleted" } };
  if (opts.userId) where.userId = opts.userId;

  const day = String(opts.date || "").trim();
  const timezone = String(opts.timezone || "UTC").trim() || "UTC";
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const { start, end } = zonedDayBoundsUtc(day, timezone);
    where.startedAt = { gte: start, lt: end };
  }

  const q = String(opts.q || "").trim();
  if (q) {
    where.OR = [
      { primaryUrl: { contains: q, mode: "insensitive" } },
      { pageTitle: { contains: q, mode: "insensitive" } },
      { clientSessionId: { contains: q, mode: "insensitive" } },
      { user: { email: { contains: q, mode: "insensitive" } } },
      { user: { firstName: { contains: q, mode: "insensitive" } } },
      { user: { lastName: { contains: q, mode: "insensitive" } } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.rrwebSession.count({ where: where as never }),
    prisma.rrwebSession.findMany({
      where: where as never,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
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

  const sessions = [];
  for (const row of rows) {
    sessions.push(await mapSession(row));
  }
  return { sessions, total, page, limit };
}

export async function adminGetRrwebSession(
  id: string,
  opts?: { includeEvents?: boolean }
) {
  await finalizeStaleRecordingSessions({ id });

  const session = await prisma.rrwebSession.findFirst({
    where: { id, status: { not: "deleted" } },
    include: {
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
  if (!session) throw new AppError(404, "rrweb session not found");
  // Fast path: signed eventsUrl only (FE downloads gzip). Opt-in embed via ?includeEvents=1
  return mapSession(session, {
    includeEvents: Boolean(opts?.includeEvents),
  });
}

function eventsEncodingForSession(session: {
  storageKey: string | null;
  eventsUrl: string | null;
}): "gzip" | "json" {
  if (
    session.storageKey?.endsWith(".gz") ||
    session.eventsUrl?.includes(".json.gz")
  ) {
    return "gzip";
  }
  return "json";
}

/**
 * Open a readable stream of stored events (gzip or json) for proxying to the
 * browser. Prefer this over buffering the whole object in memory — start bytes
 * reach the client as soon as B2 responds (avoids slow "wait for full download").
 */
export async function adminOpenRrwebEventsStream(id: string): Promise<{
  stream: NodeJS.ReadableStream;
  contentLength?: number;
  encoding: "gzip" | "json";
  filename: string;
}> {
  const session = await prisma.rrwebSession.findFirst({
    where: { id, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");
  if (!session.eventsUrl) {
    throw new AppError(404, "No events uploaded for this session yet");
  }
  const opened = await openBackblazeReadStream(session.eventsUrl);
  const encoding = eventsEncodingForSession(session);
  return {
    stream: opened.stream,
    contentLength: opened.contentLength,
    encoding,
    filename: encoding === "gzip" ? "events.json.gz" : "events.json",
  };
}

/**
 * Buffer entire events object (legacy / tests). Prefer adminOpenRrwebEventsStream
 * for HTTP responses.
 */
export async function adminGetRrwebEventsBuffer(id: string): Promise<{
  buffer: Buffer;
  encoding: "gzip" | "json";
  filename: string;
}> {
  const session = await prisma.rrwebSession.findFirst({
    where: { id, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");
  if (!session.eventsUrl) {
    throw new AppError(404, "No events uploaded for this session yet");
  }
  const buf = await downloadBackblazeFileByUrl(session.eventsUrl);
  const encoding: "gzip" | "json" = isGzipBuffer(buf)
    ? "gzip"
    : eventsEncodingForSession(session);
  return {
    buffer: buf,
    encoding,
    filename: encoding === "gzip" ? "events.json.gz" : "events.json",
  };
}

export async function adminDeleteRrwebSession(id: string) {
  const session = await prisma.rrwebSession.findFirst({
    where: { id, status: { not: "deleted" } },
  });
  if (!session) throw new AppError(404, "rrweb session not found");
  if (session.storageKey) {
    await deleteBackblazeObjectByKey(session.storageKey);
  }
  await prisma.rrwebSession.update({
    where: { id: session.id },
    data: {
      status: "deleted",
      eventsUrl: null,
      storageKey: null,
      eventCount: 0,
      frameCount: 0,
    },
  });
  publishRrwebSessionEvent({
    type: "session.deleted",
    sessionId: session.id,
    userId: session.userId,
  });
  return { ok: true, id: session.id };
}

/**
 * Soft-delete rrweb sessions older than `retentionDays` (by startedAt),
 * remove B2 event objects, and notify SSE listeners.
 */
export async function purgeExpiredRrwebSessions(
  retentionDays = 10
): Promise<{ deleted: number; cutoffIso: string }> {
  const days = Math.max(1, Math.floor(retentionDays));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let deleted = 0;
  const batchSize = 50;

  for (;;) {
    const batch = await prisma.rrwebSession.findMany({
      where: {
        status: { not: "deleted" },
        startedAt: { lt: cutoff },
      },
      select: {
        id: true,
        userId: true,
        storageKey: true,
      },
      take: batchSize,
      orderBy: { startedAt: "asc" },
    });
    if (!batch.length) break;

    for (const session of batch) {
      if (session.storageKey) {
        try {
          await deleteBackblazeObjectByKey(session.storageKey);
        } catch {
          // Best-effort B2 cleanup — still soft-delete the row.
        }
      }
      await prisma.rrwebSession.update({
        where: { id: session.id },
        data: {
          status: "deleted",
          eventsUrl: null,
          storageKey: null,
          eventCount: 0,
          frameCount: 0,
        },
      });
      publishRrwebSessionEvent({
        type: "session.deleted",
        sessionId: session.id,
        userId: session.userId,
      });
      deleted += 1;
    }
    if (batch.length < batchSize) break;
  }

  return { deleted, cutoffIso: cutoff.toISOString() };
}

export async function adminMarkRrwebSessionReviewed(id: string) {
  const session = await prisma.rrwebSession.findFirst({
    where: { id, status: { not: "deleted" } },
    include: {
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
  if (!session) throw new AppError(404, "rrweb session not found");

  const updated = await prisma.rrwebSession.update({
    where: { id: session.id },
    data: {
      reviewed: true,
      reviewedAt: session.reviewedAt || new Date(),
    },
    include: {
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
  publishRrwebSessionEvent({ type: "session.reviewed", session: mapped });
  return { ok: true, session: mapped };
}
