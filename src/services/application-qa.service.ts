import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { deriveCompanyName } from "../lib/application-qa-company";
import {
  isSensitiveField,
  normalizeElementKey,
} from "../lib/application-qa-sensitive";
import { publishApplicationQaEvent } from "../lib/application-qa-events";
import {
  parseOptionalIsoDate,
  zonedDayBoundsUtc,
} from "../lib/zoned-day";
import type {
  PatchApplicationQaSessionInput,
  SyncApplicationQaInput,
} from "../validators/application-qa.validator";

type ItemRow = {
  id: string;
  questionKey: string;
  question: string;
  answer: string;
  fieldType: string | null;
  eventType?: string | null;
  cssSelector?: string | null;
  elementTag?: string | null;
  elementId?: string | null;
  elementName?: string | null;
  elementClass?: string | null;
  attributes?: Prisma.JsonValue | null;
  occurredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const sessionOwnerInclude = {
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
    },
  },
  items: { orderBy: [{ occurredAt: "asc" as const }, { updatedAt: "asc" as const }] },
} satisfies Prisma.ApplicationQaSessionInclude;

function parseClientTimestamp(raw: unknown): Date | null {
  if (raw == null) return null;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw === "string" && raw.trim()) {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 1e11) {
      const d = new Date(asNum);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function elementSummary(ev: {
  label?: string;
  tagName?: string;
  inputType?: string;
  elementId?: string;
  name?: string;
  cssSelector?: string;
}): string {
  if (ev.label?.trim()) return ev.label.trim().slice(0, 2000);
  const tag = (ev.tagName || "element").toLowerCase();
  const type = ev.inputType ? `[type=${ev.inputType}]` : "";
  const id = ev.elementId ? `#${ev.elementId}` : "";
  const name = ev.name ? `[name=${ev.name}]` : "";
  const sel = ev.cssSelector ? ` ${ev.cssSelector}` : "";
  return `${tag}${type}${id}${name}${sel}`.trim().slice(0, 2000);
}

function mapItem(item: ItemRow) {
  const attrs =
    item.attributes &&
    typeof item.attributes === "object" &&
    !Array.isArray(item.attributes)
      ? (item.attributes as Record<string, string>)
      : undefined;

  const event = {
    id: item.id,
    elementKey: item.questionKey,
    value: item.answer,
    eventType: item.eventType ?? undefined,
    tagName: item.elementTag ?? undefined,
    inputType: item.fieldType ?? undefined,
    elementId: item.elementId ?? undefined,
    name: item.elementName ?? undefined,
    className: item.elementClass ?? undefined,
    cssSelector: item.cssSelector ?? undefined,
    attributes: attrs,
    label: item.question,
    occurredAt: (item.occurredAt ?? item.updatedAt).toISOString(),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };

  return {
    ...event,
    // Legacy aliases (FE migrating off Q&A labels)
    question: item.question,
    answer: item.answer,
    fieldType: item.fieldType ?? undefined,
  };
}

function mapSession(
  session: {
    id: string;
    userId: string;
    tabSessionId: string;
    tabUrl: string;
    pageTitle: string | null;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    lastSyncedAt: Date;
    items?: ItemRow[];
    user?: {
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
    };
  },
  opts?: { includeItems?: boolean }
) {
  const companyName = deriveCompanyName({
    pageTitle: session.pageTitle,
    tabUrl: session.tabUrl,
  });

  const base: Record<string, unknown> = {
    id: session.id,
    userId: session.userId,
    tabSessionId: session.tabSessionId,
    tabUrl: session.tabUrl,
    pageTitle: session.pageTitle ?? undefined,
    ...(companyName ? { companyName } : {}),
    status: session.status,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    lastSyncedAt: session.lastSyncedAt.toISOString(),
    recordedAt: session.lastSyncedAt.toISOString(),
    itemCount: session.items?.length,
    eventCount: session.items?.length,
  };

  if (session.user) {
    base.owner = {
      id: session.user.id,
      email: session.user.email,
      firstName: session.user.firstName,
      lastName: session.user.lastName,
      name:
        [session.user.firstName, session.user.lastName]
          .filter(Boolean)
          .join(" ") || session.user.email,
    };
  }

  if (opts?.includeItems !== false && session.items) {
    const mapped = session.items.map(mapItem);
    base.inputEvents = mapped;
    base.input_events = mapped;
    // Legacy — same rows; label/value only
    base.questionsAnswers = mapped;
    base.questions_answers = mapped.map((i) => ({
      question: i.question,
      answer: i.answer,
    }));
  }

  return base;
}

export async function syncApplicationQa(
  userId: string,
  input: SyncApplicationQaInput
) {
  const events = (input.inputEvents || []).filter((ev) => {
    const key = normalizeElementKey(ev.elementKey || "");
    if (!key) return false;
    return !isSensitiveField({
      question: ev.label || key,
      fieldType: ev.inputType,
      fieldName: ev.name,
      name: ev.name,
      elementId: ev.elementId,
      className: ev.className,
      cssSelector: ev.cssSelector,
      autocomplete: ev.autocomplete,
    });
  });

  const existing = await prisma.applicationQaSession.findUnique({
    where: {
      userId_tabSessionId: {
        userId,
        tabSessionId: input.tabSessionId,
      },
    },
    select: { id: true, status: true },
  });
  const isCreate = !existing || existing.status === "deleted";

  let status = input.status ?? "recording";
  if (!input.status && existing && existing.status !== "deleted") {
    status = existing.status === "paused" ? "paused" : "recording";
  }
  if (existing?.status === "deleted" && !input.status) {
    status = "recording";
  }

  const session = await prisma.applicationQaSession.upsert({
    where: {
      userId_tabSessionId: {
        userId,
        tabSessionId: input.tabSessionId,
      },
    },
    create: {
      userId,
      tabSessionId: input.tabSessionId,
      tabUrl: input.tabUrl,
      pageTitle: input.pageTitle,
      status,
      lastSyncedAt: new Date(),
    },
    update: {
      tabUrl: input.tabUrl,
      ...(input.pageTitle !== undefined ? { pageTitle: input.pageTitle } : {}),
      status,
      lastSyncedAt: new Date(),
    },
  });

  let skippedUnchanged = 0;

  for (const ev of events) {
    const elementKey = normalizeElementKey(ev.elementKey);
    if (!elementKey) continue;

    const value = ev.value ?? "";
    const label = elementSummary(ev);
    const occurredAt = parseClientTimestamp(ev.timestamp) ?? new Date();
    const fieldType = ev.inputType?.trim() || null;
    const eventType = ev.eventType?.trim() || null;
    const cssSelector = ev.cssSelector?.trim() || null;
    const elementTag = ev.tagName?.trim()?.toLowerCase() || null;
    const elementId = ev.elementId?.trim() || null;
    const elementName = ev.name?.trim() || null;
    const elementClass = ev.className?.trim() || null;
    const attributes =
      ev.attributes && Object.keys(ev.attributes).length
        ? (ev.attributes as Prisma.InputJsonValue)
        : Prisma.JsonNull;

    const prior = await prisma.applicationQaItem.findUnique({
      where: {
        sessionId_questionKey: {
          sessionId: session.id,
          questionKey: elementKey,
        },
      },
      select: { answer: true },
    });

    // Avoid duplicate writes when the value did not change.
    if (prior && prior.answer === value) {
      skippedUnchanged += 1;
      continue;
    }

    await prisma.applicationQaItem.upsert({
      where: {
        sessionId_questionKey: {
          sessionId: session.id,
          questionKey: elementKey,
        },
      },
      create: {
        sessionId: session.id,
        questionKey: elementKey,
        question: label,
        answer: value,
        fieldType,
        eventType,
        cssSelector,
        elementTag,
        elementId,
        elementName,
        elementClass,
        attributes,
        occurredAt,
      },
      update: {
        question: label,
        answer: value,
        fieldType,
        eventType,
        cssSelector,
        elementTag,
        elementId,
        elementName,
        elementClass,
        attributes,
        occurredAt,
      },
    });
  }

  const full = await prisma.applicationQaSession.findUniqueOrThrow({
    where: { id: session.id },
    include: sessionOwnerInclude,
  });

  const mapped = mapSession(full);
  if (mapped.itemCount == null && Array.isArray(full.items)) {
    mapped.itemCount = full.items.length;
    mapped.eventCount = full.items.length;
  }
  publishApplicationQaEvent({
    type: isCreate ? "session.created" : "session.updated",
    session: mapped,
  });

  return {
    ok: true,
    created: isCreate,
    skippedSensitive: (input.inputEvents?.length || 0) - events.length,
    skippedUnchanged,
    session: mapped,
  };
}

export async function listOwnSessions(
  userId: string,
  opts: { page?: number; limit?: number } = {}
) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const where = { userId, status: { not: "deleted" } };

  const [total, rows] = await Promise.all([
    prisma.applicationQaSession.count({ where }),
    prisma.applicationQaSession.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        items: { select: { id: true } },
      },
    }),
  ]);

  return {
    page,
    limit,
    total,
    sessions: rows.map((s) =>
      mapSession({ ...s, items: undefined as never }, { includeItems: false })
    ).map((s, i) => ({ ...s, itemCount: rows[i]!.items.length })),
  };
}

export async function getOwnSession(userId: string, sessionId: string) {
  const session = await prisma.applicationQaSession.findFirst({
    where: { id: sessionId, userId, status: { not: "deleted" } },
    include: {
      items: {
        orderBy: [{ occurredAt: "asc" }, { updatedAt: "asc" }],
      },
    },
  });
  if (!session) throw new AppError(404, "Recording not found");
  return { session: mapSession(session) };
}

export async function patchOwnSession(
  userId: string,
  sessionId: string,
  input: PatchApplicationQaSessionInput
) {
  const existing = await prisma.applicationQaSession.findFirst({
    where: { id: sessionId, userId, status: { not: "deleted" } },
    select: { id: true },
  });
  if (!existing) throw new AppError(404, "Recording not found");

  const session = await prisma.applicationQaSession.update({
    where: { id: sessionId },
    data: { status: input.status, lastSyncedAt: new Date() },
    include: sessionOwnerInclude,
  });
  const mapped = mapSession(session);
  publishApplicationQaEvent({ type: "session.updated", session: mapped });
  return { session: mapped };
}

export async function deleteOwnSession(userId: string, sessionId: string) {
  const existing = await prisma.applicationQaSession.findFirst({
    where: { id: sessionId, userId, status: { not: "deleted" } },
    select: { id: true, userId: true },
  });
  if (!existing) throw new AppError(404, "Recording not found");

  await prisma.applicationQaSession.update({
    where: { id: sessionId },
    data: { status: "deleted" },
  });
  publishApplicationQaEvent({
    type: "session.deleted",
    sessionId,
    userId: existing.userId,
  });
  return { ok: true };
}

/** Super Admin: owners that have at least one non-deleted session. */
export async function adminListOwners() {
  const grouped = await prisma.applicationQaSession.groupBy({
    by: ["userId"],
    where: { status: { not: "deleted" } },
    _count: { _all: true },
    _max: { updatedAt: true },
  });

  if (!grouped.length) {
    return { owners: [] };
  }

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
      return {
        userId: g.userId,
        email: u?.email ?? "unknown",
        firstName: u?.firstName ?? null,
        lastName: u?.lastName ?? null,
        name:
          [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
          u?.email ||
          g.userId,
        sessionCount: g._count._all,
        lastSyncedAt: g._max.updatedAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => (b.lastSyncedAt ?? "").localeCompare(a.lastSyncedAt ?? ""));

  return { owners };
}

export async function adminListSessions(opts: {
  userId?: string;
  q?: string;
  page?: number;
  limit?: number;
  /** Calendar day YYYY-MM-DD in `timezone`. */
  date?: string;
  timezone?: string;
  /** Optional ISO range (used when `date` is absent). */
  from?: string;
  to?: string;
}) {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const q = opts.q?.trim();

  // Activity timestamp = lastSyncedAt (always set; preferred over updatedAt/createdAt).
  let activityFilter: Prisma.DateTimeFilter | undefined;
  const day = opts.date?.trim();
  if (day) {
    const { start, end } = zonedDayBoundsUtc(
      day,
      opts.timezone?.trim() || "America/New_York"
    );
    activityFilter = { gte: start, lt: end };
  } else {
    const from = parseOptionalIsoDate(opts.from);
    const to = parseOptionalIsoDate(opts.to);
    if (from || to) {
      activityFilter = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lt: to } : {}),
      };
    }
  }

  // Activity = lastSyncedAt (preferred; always set). AND with userId / q.
  const whereFinal: Prisma.ApplicationQaSessionWhereInput = {
    status: { not: "deleted" },
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(activityFilter ? { lastSyncedAt: activityFilter } : {}),
    ...(q
      ? {
          OR: [
            { tabUrl: { contains: q, mode: "insensitive" } },
            { pageTitle: { contains: q, mode: "insensitive" } },
            {
              user: {
                OR: [
                  { email: { contains: q, mode: "insensitive" } },
                  { firstName: { contains: q, mode: "insensitive" } },
                  { lastName: { contains: q, mode: "insensitive" } },
                ],
              },
            },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.applicationQaSession.count({ where: whereFinal }),
    prisma.applicationQaSession.findMany({
      where: whereFinal,
      orderBy: [{ lastSyncedAt: "desc" }, { updatedAt: "desc" }],
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
        items: { select: { id: true } },
      },
    }),
  ]);

  return {
    page,
    limit,
    total,
    ...(day
      ? {
          date: day,
          timezone: opts.timezone?.trim() || "America/New_York",
        }
      : {}),
    sessions: rows.map((s) => ({
      ...mapSession(
        { ...s, items: undefined as never },
        { includeItems: false }
      ),
      itemCount: s.items.length,
    })),
  };
}

export async function adminGetSession(sessionId: string) {
  const session = await prisma.applicationQaSession.findFirst({
    where: { id: sessionId, status: { not: "deleted" } },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
        },
      },
      items: {
        orderBy: [{ occurredAt: "asc" }, { updatedAt: "asc" }],
      },
    },
  });
  if (!session) throw new AppError(404, "Recording not found");
  return { session: mapSession(session) };
}

export async function adminDeleteSession(sessionId: string) {
  const existing = await prisma.applicationQaSession.findFirst({
    where: { id: sessionId, status: { not: "deleted" } },
    select: { id: true, userId: true },
  });
  if (!existing) throw new AppError(404, "Recording not found");
  await prisma.applicationQaSession.update({
    where: { id: sessionId },
    data: { status: "deleted" },
  });
  publishApplicationQaEvent({
    type: "session.deleted",
    sessionId,
    userId: existing.userId,
  });
  return { ok: true };
}
