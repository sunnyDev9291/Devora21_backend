import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import {
  absoluteKpiWindows,
  assertValidTimezone,
  formatYmd,
  listYmdRange,
  resolveAnalyticsWindow,
  zonedYmd,
  type AnalyticsPreset,
} from "../lib/admin-resume-time";
import { openAdminResumeArchiveFileStream } from "./resume-archive.service";
import {
  interviewHistoryView,
  parseInterviewHistory,
} from "../lib/interview-history";
import { normalizeCompanyQuery } from "../utils/archive-filters";
import { logger } from "../lib/logger";

function escapeIlike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function profileDisplayName(
  firstName: string | null,
  lastName: string | null,
  email: string
): string {
  const parts = [firstName, lastName].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  return email.split("@")[0] ?? email;
}

function parsePositiveInt(raw: unknown, fallback: number, max?: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  const v = Math.floor(n);
  return max ? Math.min(max, v) : v;
}

type FilterOpts = {
  userId?: string;
  profileName?: string;
};

function buildArchiveFilterSql(opts: FilterOpts): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (opts.userId) {
    parts.push(Prisma.sql`a."userId" = ${opts.userId}`);
  }
  if (opts.profileName?.trim()) {
    const pat = `%${escapeIlike(opts.profileName.trim())}%`;
    parts.push(Prisma.sql`(
      u.email ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(u."firstName", '') ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(u."lastName", '') ILIKE ${pat} ESCAPE '\\'
      OR TRIM(CONCAT(COALESCE(u."firstName", ''), ' ', COALESCE(u."lastName", ''))) ILIKE ${pat} ESCAPE '\\'
    )`);
  }
  return Prisma.join(parts, " AND ");
}

/**
 * Prisma DateTime → Postgres `timestamp without time zone` (UTC wall clock).
 * Compare/bucket via AT TIME ZONE 'UTC' so session TimeZone cannot shift days.
 */
function bidAtAsTimestamptz(): Prisma.Sql {
  return Prisma.sql`(a."bidAt" AT TIME ZONE 'UTC')`;
}

function bidAtLocalDayExpr(timezone: string): Prisma.Sql {
  return Prisma.sql`to_char((a."bidAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timezone}, 'YYYY-MM-DD')`;
}

async function countInRange(
  start: Date,
  end: Date,
  filter: Prisma.Sql
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT COUNT(*)::bigint AS c
    FROM resume_archives a
    JOIN "User" u ON u.id = a."userId"
    WHERE ${bidAtAsTimestamptz()} >= ${start}
      AND ${bidAtAsTimestamptz()} < ${end}
      AND ${filter}
  `;
  return Number(rows[0]?.c ?? 0);
}

export async function getAdminResumeAnalytics(query: Record<string, unknown>) {
  const timezone = assertValidTimezone(
    typeof query.timezone === "string" ? query.timezone : "UTC"
  );
  const preset = (typeof query.preset === "string" ? query.preset : "month") as string;
  const window = resolveAnalyticsWindow({
    preset,
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
    timezone,
  });

  const userId =
    (typeof query.userId === "string" && query.userId.trim()) ||
    (typeof query.profileId === "string" && query.profileId.trim()) ||
    undefined;
  const profileName =
    typeof query.profileName === "string" ? query.profileName : undefined;

  const filter = buildArchiveFilterSql({ userId, profileName });
  const kpi = absoluteKpiWindows(timezone);

  const [today, week, month, allTime, range, previousRange] = await Promise.all([
    countInRange(kpi.todayStart, kpi.now, filter),
    countInRange(kpi.weekStart, kpi.now, filter),
    countInRange(kpi.monthStart, kpi.now, filter),
    countInRange(new Date(0), kpi.now, filter),
    countInRange(window.rangeStart, window.rangeEnd, filter),
    window.previousStart && window.previousEnd
      ? countInRange(window.previousStart, window.previousEnd, filter)
      : Promise.resolve(null as number | null),
  ]);

  const dayRows = await prisma.$queryRaw<Array<{ day: string; c: bigint }>>`
    SELECT
      ${bidAtLocalDayExpr(timezone)} AS day,
      COUNT(*)::bigint AS c
    FROM resume_archives a
    JOIN "User" u ON u.id = a."userId"
    WHERE ${bidAtAsTimestamptz()} >= ${window.rangeStart}
      AND ${bidAtAsTimestamptz()} < ${window.rangeEnd}
      AND ${filter}
    GROUP BY 1
    ORDER BY 1
  `;

  const prevDayRows =
    window.previousStart && window.previousEnd
      ? await prisma.$queryRaw<Array<{ day: string; c: bigint }>>`
          SELECT
            ${bidAtLocalDayExpr(timezone)} AS day,
            COUNT(*)::bigint AS c
          FROM resume_archives a
          JOIN "User" u ON u.id = a."userId"
          WHERE ${bidAtAsTimestamptz()} >= ${window.previousStart}
            AND ${bidAtAsTimestamptz()} < ${window.previousEnd}
            AND ${filter}
          GROUP BY 1
          ORDER BY 1
        `
      : [];

  const currentMap = new Map<string, number>();
  for (const row of dayRows) {
    currentMap.set(row.day, Number(row.c));
  }

  let seriesFrom = window.fromDate;
  let seriesTo = window.toDate;
  const allDates = listYmdRange(window.fromDate, window.toDate, timezone);
  if (allDates.length > 93) {
    seriesFrom = allDates[allDates.length - 93];
    seriesTo = allDates[allDates.length - 1];
  }

  const prevDates =
    window.previousFromDate && window.previousToDate
      ? listYmdRange(window.previousFromDate, window.previousToDate, timezone)
      : [];
  const seriesDates = listYmdRange(seriesFrom, seriesTo, timezone);
  const seriesOffset = Math.max(0, allDates.length - seriesDates.length);
  const prevCounts = prevDates.map((d) => {
    const hit = prevDayRows.find((r) => r.day === d);
    return Number(hit?.c ?? 0);
  });

  const series = seriesDates.map((date, idx) => ({
    date,
    count: currentMap.get(date) ?? 0,
    previousCount: prevCounts[seriesOffset + idx] ?? 0,
  }));

  const topRows = await prisma.$queryRaw<
    Array<{
      userId: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      c: bigint;
    }>
  >`
    SELECT
      a."userId" AS "userId",
      u.email,
      u."firstName" AS "firstName",
      u."lastName" AS "lastName",
      COUNT(*)::bigint AS c
    FROM resume_archives a
    JOIN "User" u ON u.id = a."userId"
    WHERE ${bidAtAsTimestamptz()} >= ${window.rangeStart}
      AND ${bidAtAsTimestamptz()} < ${window.rangeEnd}
      AND ${filter}
    GROUP BY a."userId", u.email, u."firstName", u."lastName"
    ORDER BY c DESC
    LIMIT 10
  `;

  const topProfiles = await Promise.all(
    topRows.map(async (row) => {
      const uid = row.userId;
      const userFilter = buildArchiveFilterSql({ userId: uid });
      const [t, w, m, all] = await Promise.all([
        countInRange(kpi.todayStart, kpi.now, userFilter),
        countInRange(kpi.weekStart, kpi.now, userFilter),
        countInRange(kpi.monthStart, kpi.now, userFilter),
        countInRange(new Date(0), kpi.now, userFilter),
      ]);
      return {
        profileId: uid,
        profileName: profileDisplayName(row.firstName, row.lastName, row.email),
        profileEmail: row.email,
        count: Number(row.c),
        today: t,
        week: w,
        month: m,
        allTime: all,
      };
    })
  );

  return {
    timezone: window.timezone,
    from: window.fromDate,
    to: window.toDate,
    preset: window.preset as AnalyticsPreset,
    totals: {
      today,
      week,
      month,
      allTime,
      range,
      previousRange,
    },
    series,
    topProfiles,
  };
}

/**
 * Super Admin integrated resume search (Search tab).
 *
 * Matching (v1): phrase ILIKE '%q%' against companyName, jobTitle,
 * jobDescription, resumeFileName, pdfFileName, plus profile name/email.
 * Blank q → empty list (never dumps all archives).
 */
export async function listAdminResumes(query: Record<string, unknown>) {
  const page = parsePositiveInt(query.page, 1);
  const limit = parsePositiveInt(query.limit, 25, 100);
  const offset = (page - 1) * limit;

  const empty = () => ({
    items: [] as Array<{
      id: string;
      profileId: string;
      profileEmail: string;
      profileName: string;
      jobTitle: string;
      companyName: string;
      jobDescription: string;
      createdAt: string;
      resumeFileName: string;
      pdfFileName: string;
      hasDocx: boolean;
      hasPdf: boolean;
      interviewHistory: Array<{ round: number; downloadedAt: string }>;
      nextInterviewRound: number;
    }>,
    total: 0,
    page,
    limit,
  });

  const q = typeof query.q === "string" ? query.q.trim() : "";
  // Search tab never lists without a keyword — blank must not dump archives.
  if (!q) {
    return empty();
  }

  // Prefer multi-profileIds; also accepts repeated profileId= / userId=.
  const profileIds = collectProfileIds(query);
  const profileKeyPresent =
    query.profileIds !== undefined ||
    query.profileId !== undefined ||
    query.userIds !== undefined ||
    query.userId !== undefined;
  // Explicit empty selection (e.g. profileIds=) → empty result, not all profiles.
  if (profileKeyPresent && profileIds.length === 0) {
    return empty();
  }

  const timezone = assertValidTimezone(
    typeof query.timezone === "string" ? query.timezone : "UTC"
  );
  // FE Search tab sends preset=all (not date-scoped). Optional window still applied.
  const preset = typeof query.preset === "string" ? query.preset : "all";
  const window = resolveAnalyticsWindow({
    preset,
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
    timezone,
  });

  // Legacy field filters (optional; Search tab uses integrated q only).
  const company =
    typeof query.company === "string" ? query.company.trim() : "";
  const jobTitle =
    typeof query.jobTitle === "string" ? query.jobTitle.trim() : "";
  const jd =
    typeof query.jobDescription === "string"
      ? query.jobDescription.trim()
      : typeof query.jd === "string"
        ? query.jd.trim()
        : "";
  const profileName =
    typeof query.profileName === "string" ? query.profileName.trim() : "";

  const sortByRaw =
    typeof query.sortBy === "string" ? query.sortBy.trim() : "createdAt";
  const sortDir =
    String(query.sortDir ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";

  const whereParts: Prisma.Sql[] = [
    Prisma.sql`${bidAtAsTimestamptz()} >= ${window.rangeStart}`,
    Prisma.sql`${bidAtAsTimestamptz()} < ${window.rangeEnd}`,
  ];

  if (profileIds.length > 0) {
    whereParts.push(
      Prisma.sql`a."userId" IN (${Prisma.join(profileIds)})`
    );
  }

  if (company) {
    const pat = `%${escapeIlike(company)}%`;
    whereParts.push(Prisma.sql`a."companyName" ILIKE ${pat} ESCAPE '\\'`);
  }
  if (jobTitle) {
    const pat = `%${escapeIlike(jobTitle)}%`;
    whereParts.push(Prisma.sql`a."jobTitle" ILIKE ${pat} ESCAPE '\\'`);
  }
  if (jd) {
    const pat = `%${escapeIlike(jd)}%`;
    whereParts.push(
      Prisma.sql`COALESCE(a."jobDescription", '') ILIKE ${pat} ESCAPE '\\'`
    );
  }
  if (profileName) {
    const pat = `%${escapeIlike(profileName)}%`;
    whereParts.push(Prisma.sql`(
      u.email ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(u."firstName", '') ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(u."lastName", '') ILIKE ${pat} ESCAPE '\\'
      OR TRIM(CONCAT(COALESCE(u."firstName", ''), ' ', COALESCE(u."lastName", ''))) ILIKE ${pat} ESCAPE '\\'
    )`);
  }

  // Integrated phrase match (entire q as one substring).
  {
    const pat = `%${escapeIlike(q)}%`;
    whereParts.push(Prisma.sql`(
      a."companyName" ILIKE ${pat} ESCAPE '\\'
      OR a."jobTitle" ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(a."jobDescription", '') ILIKE ${pat} ESCAPE '\\'
      OR a."resumeFileName" ILIKE ${pat} ESCAPE '\\'
      OR a."pdfFileName" ILIKE ${pat} ESCAPE '\\'
      OR u.email ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(u."firstName", '') ILIKE ${pat} ESCAPE '\\'
      OR COALESCE(u."lastName", '') ILIKE ${pat} ESCAPE '\\'
      OR TRIM(CONCAT(COALESCE(u."firstName", ''), ' ', COALESCE(u."lastName", ''))) ILIKE ${pat} ESCAPE '\\'
    )`);
  }

  const whereSql = Prisma.join(whereParts, " AND ");

  const dirSql = sortDir === "asc" ? "ASC" : "DESC";
  const orderClause = (() => {
    switch (sortByRaw) {
      case "companyName":
        return `a."companyName" ${dirSql}, a."bidAt" DESC`;
      case "jobTitle":
        return `a."jobTitle" ${dirSql}, a."bidAt" DESC`;
      case "profileName":
        return `TRIM(CONCAT(COALESCE(u."firstName", ''), ' ', COALESCE(u."lastName", ''))) ${dirSql}, a."bidAt" DESC`;
      case "createdAt":
      default:
        return `a."bidAt" ${dirSql}`;
    }
  })();

  const countRows = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT COUNT(*)::bigint AS c
    FROM resume_archives a
    JOIN "User" u ON u.id = a."userId"
    WHERE ${whereSql}
  `;
  const total = Number(countRows[0]?.c ?? 0);

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      userId: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      jobTitle: string;
      companyName: string;
      jobDescription: string | null;
      bidAt: Date;
      resumeFileName: string;
      pdfFileName: string;
      docxUrl: string | null;
      pdfUrl: string | null;
      docxStorageKey: string | null;
      pdfStorageKey: string | null;
      interviewHistory: unknown;
    }>
  >`
    SELECT
      a.id,
      a."userId" AS "userId",
      u.email,
      u."firstName" AS "firstName",
      u."lastName" AS "lastName",
      a."jobTitle" AS "jobTitle",
      a."companyName" AS "companyName",
      a."jobDescription" AS "jobDescription",
      a."bidAt" AS "bidAt",
      a."resumeFileName" AS "resumeFileName",
      a."pdfFileName" AS "pdfFileName",
      a."docxUrl" AS "docxUrl",
      a."pdfUrl" AS "pdfUrl",
      a."docxStorageKey" AS "docxStorageKey",
      a."pdfStorageKey" AS "pdfStorageKey",
      a.interview_history AS "interviewHistory"
    FROM resume_archives a
    JOIN "User" u ON u.id = a."userId"
    WHERE ${whereSql}
    ORDER BY ${Prisma.raw(orderClause)}
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  return {
    items: rows.map((r) => {
      const history = interviewHistoryView(r.interviewHistory);
      return {
        id: r.id,
        profileId: r.userId,
        profileEmail: r.email,
        profileName: profileDisplayName(r.firstName, r.lastName, r.email),
        jobTitle: r.jobTitle,
        companyName: r.companyName,
        jobDescription: r.jobDescription ?? "",
        createdAt: r.bidAt.toISOString(),
        resumeFileName: r.resumeFileName,
        pdfFileName: r.pdfFileName,
        hasDocx: Boolean(r.docxUrl || r.docxStorageKey),
        hasPdf: Boolean(r.pdfUrl || r.pdfStorageKey),
        interviewHistory: history.interviewHistory,
        nextInterviewRound: history.nextInterviewRound,
      };
    }),
    total,
    page,
    limit,
  };
}

function collectProfileIds(query: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  const push = (raw: unknown) => {
    if (typeof raw === "string") {
      for (const part of raw.split(",")) {
        const id = part.trim();
        if (id) ids.add(id);
      }
    } else if (Array.isArray(raw)) {
      for (const item of raw) push(item);
    }
  };
  push(query.profileIds);
  push(query.profileId);
  push(query.userId);
  push(query.userIds);
  return [...ids];
}

type ProfileMeta = {
  profileId: string;
  profileName: string;
  profileEmail: string;
};

async function resolveSelectedProfiles(query: Record<string, unknown>): Promise<{
  profileIds: string[];
  profiles: ProfileMeta[];
}> {
  const requestedIds = collectProfileIds(query);
  if (requestedIds.length > 50) {
    throw new AppError(400, "profileIds is limited to 50 profiles");
  }
  if (requestedIds.length === 0) {
    return { profileIds: [], profiles: [] };
  }
  const users = await prisma.user.findMany({
    where: { id: { in: requestedIds } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));
  const profileIds = requestedIds.filter((id) => userById.has(id));
  const profiles = profileIds.map((id) => {
    const u = userById.get(id)!;
    return {
      profileId: u.id,
      profileName: profileDisplayName(u.firstName, u.lastName, u.email),
      profileEmail: u.email,
    };
  });
  return { profileIds, profiles };
}

function emptyByProfile(profileIds: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of profileIds) out[id] = 0;
  return out;
}

/**
 * Section 2 circular KPIs — fixed calendar periods (ignore chart from/to).
 * Selected-profile set only.
 */
export async function getAdminResumeOverviewAnalytics(
  query: Record<string, unknown>
) {
  const timezone = assertValidTimezone(
    typeof query.timezone === "string" ? query.timezone : "UTC"
  );
  const { profileIds, profiles } = await resolveSelectedProfiles(query);

  const emptyBucket = () => ({
    total: 0,
    byProfile: emptyByProfile(profileIds),
  });

  if (profileIds.length === 0) {
    return {
      timezone,
      today: emptyBucket(),
      week: emptyBucket(),
      month: emptyBucket(),
      allTime: emptyBucket(),
      profiles: [],
    };
  }

  const kpi = absoluteKpiWindows(timezone);

  const rows = await prisma.$queryRaw<
    Array<{
      userId: string;
      today: bigint;
      week: bigint;
      month: bigint;
      allTime: bigint;
    }>
  >`
    SELECT
      a."userId" AS "userId",
      COUNT(*) FILTER (
        WHERE ${bidAtAsTimestamptz()} >= ${kpi.todayStart}
          AND ${bidAtAsTimestamptz()} < ${kpi.now}
      )::bigint AS today,
      COUNT(*) FILTER (
        WHERE ${bidAtAsTimestamptz()} >= ${kpi.weekStart}
          AND ${bidAtAsTimestamptz()} < ${kpi.now}
      )::bigint AS week,
      COUNT(*) FILTER (
        WHERE ${bidAtAsTimestamptz()} >= ${kpi.monthStart}
          AND ${bidAtAsTimestamptz()} < ${kpi.now}
      )::bigint AS month,
      COUNT(*)::bigint AS "allTime"
    FROM resume_archives a
    WHERE a."userId" IN (${Prisma.join(profileIds)})
      AND ${bidAtAsTimestamptz()} < ${kpi.now}
    GROUP BY a."userId"
  `;

  const byUser = new Map(rows.map((r) => [r.userId, r] as const));

  const fold = (key: "today" | "week" | "month" | "allTime") => {
    const byProfile = emptyByProfile(profileIds);
    let total = 0;
    for (const id of profileIds) {
      const n = Number(byUser.get(id)?.[key] ?? 0);
      byProfile[id] = n;
      total += n;
    }
    return { total, byProfile };
  };

  return {
    timezone,
    today: fold("today"),
    week: fold("week"),
    month: fold("month"),
    allTime: fold("allTime"),
    profiles,
  };
}

/**
 * Batch multi-profile daily compare for Super Admin advanced chart.
 * SELECTED-SET KPIs only (not platform-wide).
 */
export async function getAdminResumeCompareAnalytics(
  query: Record<string, unknown>
) {
  const timezone = assertValidTimezone(
    typeof query.timezone === "string" ? query.timezone : "UTC"
  );
  const presetRaw =
    typeof query.preset === "string" ? query.preset : "last30";

  let window = resolveAnalyticsWindow({
    preset: presetRaw,
    from: typeof query.from === "string" ? query.from : undefined,
    to: typeof query.to === "string" ? query.to : undefined,
    timezone,
  });

  const { profileIds, profiles } = await resolveSelectedProfiles(query);

  if (profileIds.length === 0) {
    return {
      timezone: window.timezone,
      from: window.fromDate,
      to: window.toDate,
      preset: (presetRaw.trim().toLowerCase() as AnalyticsPreset) || window.preset,
      profiles: [] as ProfileMeta[],
      series: [] as Array<{
        date: string;
        total: number;
        byProfile: Record<string, number>;
      }>,
      rankings: [] as Array<{
        profileId: string;
        profileName: string;
        profileEmail: string;
        count: number;
        percent: number;
      }>,
      grandTotal: 0,
      totals: {
        today: 0,
        week: 0,
        month: 0,
        allTime: 0,
        range: 0,
      },
    };
  }

  // preset=all → tighten from to earliest archive day among selected profiles.
  if (presetRaw.trim().toLowerCase() === "all") {
    const earliest = await prisma.$queryRaw<Array<{ d: Date | null }>>`
      SELECT MIN(${bidAtAsTimestamptz()}) AS d
      FROM resume_archives a
      WHERE a."userId" IN (${Prisma.join(profileIds)})
    `;
    const minAt = earliest[0]?.d;
    if (minAt) {
      const p = zonedYmd(new Date(minAt), timezone);
      const fromDate = formatYmd(p.y, p.m, p.d);
      const tightened = resolveAnalyticsWindow({
        preset: "custom",
        from: fromDate,
        to: window.toDate,
        timezone,
      });
      window = {
        ...tightened,
        preset: "all",
        previousStart: null,
        previousEnd: null,
        previousFromDate: null,
        previousToDate: null,
      };
    }
  }

  const dayRows = await prisma.$queryRaw<
    Array<{ day: string; userId: string; c: bigint }>
  >`
    SELECT
      ${bidAtLocalDayExpr(timezone)} AS day,
      a."userId" AS "userId",
      COUNT(*)::bigint AS c
    FROM resume_archives a
    WHERE a."userId" IN (${Prisma.join(profileIds)})
      AND ${bidAtAsTimestamptz()} >= ${window.rangeStart}
      AND ${bidAtAsTimestamptz()} < ${window.rangeEnd}
    GROUP BY 1, 2
    ORDER BY 1
  `;

  const countMap = new Map<string, Map<string, number>>(); // day -> userId -> count
  for (const row of dayRows) {
    let byUser = countMap.get(row.day);
    if (!byUser) {
      byUser = new Map();
      countMap.set(row.day, byUser);
    }
    byUser.set(row.userId, Number(row.c));
  }

  const dates = listYmdRange(window.fromDate, window.toDate, timezone);
  const series = dates.map((date) => {
    const byProfile: Record<string, number> = {};
    let total = 0;
    const dayMap = countMap.get(date);
    for (const id of profileIds) {
      const n = dayMap?.get(id) ?? 0;
      byProfile[id] = n;
      total += n;
    }
    return { date, total, byProfile };
  });

  const rangeCounts = await prisma.$queryRaw<
    Array<{ userId: string; c: bigint }>
  >`
    SELECT a."userId" AS "userId", COUNT(*)::bigint AS c
    FROM resume_archives a
    WHERE a."userId" IN (${Prisma.join(profileIds)})
      AND ${bidAtAsTimestamptz()} >= ${window.rangeStart}
      AND ${bidAtAsTimestamptz()} < ${window.rangeEnd}
    GROUP BY a."userId"
  `;
  const rangeByUser = new Map(
    rangeCounts.map((r) => [r.userId, Number(r.c)] as const)
  );
  const grandTotal = profileIds.reduce(
    (sum, id) => sum + (rangeByUser.get(id) ?? 0),
    0
  );

  const rankings = [...profiles]
    .map((p) => {
      const count = rangeByUser.get(p.profileId) ?? 0;
      const percent =
        grandTotal > 0
          ? Math.round((count / grandTotal) * 1000) / 10
          : 0;
      return {
        profileId: p.profileId,
        profileName: p.profileName,
        profileEmail: p.profileEmail,
        count,
        percent,
      };
    })
    .sort((a, b) => b.count - a.count);

  const filter = Prisma.sql`a."userId" IN (${Prisma.join(profileIds)})`;
  const kpi = absoluteKpiWindows(timezone);
  const [today, week, month, allTime] = await Promise.all([
    countInRange(kpi.todayStart, kpi.now, filter),
    countInRange(kpi.weekStart, kpi.now, filter),
    countInRange(kpi.monthStart, kpi.now, filter),
    countInRange(new Date(0), kpi.now, filter),
  ]);

  const presetLabel =
    (presetRaw.trim().toLowerCase() as AnalyticsPreset) || window.preset;

  return {
    timezone: window.timezone,
    from: window.fromDate,
    to: window.toDate,
    preset: presetLabel,
    profiles,
    series,
    rankings,
    grandTotal,
    totals: {
      today,
      week,
      month,
      allTime,
      range: grandTotal,
    },
  };
}

export async function streamAdminResumeFile(
  archiveId: string,
  kind: "docx" | "pdf"
) {
  return openAdminResumeArchiveFileStream(archiveId, kind);
}

const OTHER_PROGRESS_LIMIT = 50;

export type OtherInterviewProgressItem = {
  id: string;
  profileId: string;
  profileName: string;
  profileEmail: string;
  jobTitle: string;
  companyName: string;
  bidAt: string;
  interviewHistory: Array<{ round: number; downloadedAt: string }>;
  nextInterviewRound: number;
};

export type OtherInterviewProgressResult = {
  companyName: string;
  items: OtherInterviewProgressItem[];
  truncated?: boolean;
  limit?: number;
};

/**
 * Cross-profile discovery: other archives at the same company with Round N+ done.
 * Read-only. Super Admin only (enforced at route).
 */
export async function findOtherInterviewProgress(
  query: Record<string, unknown>,
  opts?: { adminId?: string }
): Promise<OtherInterviewProgressResult> {
  const companyRaw =
    (typeof query.company === "string" && query.company) ||
    (typeof query.companyName === "string" && query.companyName) ||
    "";
  const companyName = normalizeCompanyQuery(companyRaw);
  if (!companyName) {
    throw new AppError(400, "company or companyName is required");
  }

  const excludeId =
    (typeof query.excludeId === "string" && query.excludeId.trim()) ||
    (typeof query.excludeArchiveId === "string" &&
      query.excludeArchiveId.trim()) ||
    "";

  const minRaw =
    query.minCompletedRound !== undefined
      ? query.minCompletedRound
      : query.minRound;
  const minCompletedRound = parsePositiveInt(minRaw, 1, 100);

  // Exact match after normalize (trim + collapse whitespace), case-insensitive.
  const companyNormSql = Prisma.sql`lower(regexp_replace(btrim(a."companyName"), '\\s+', ' ', 'g'))`;
  const companyTarget = companyName.toLowerCase();

  const whereParts: Prisma.Sql[] = [
    Prisma.sql`${companyNormSql} = ${companyTarget}`,
    Prisma.sql`a.interview_history IS NOT NULL`,
    Prisma.sql`jsonb_typeof(a.interview_history::jsonb) = 'array'`,
    Prisma.sql`EXISTS (
      SELECT 1
      FROM jsonb_array_elements(a.interview_history::jsonb) AS e
      WHERE COALESCE((e->>'round')::int, 0) >= ${minCompletedRound}
    )`,
  ];
  if (excludeId) {
    whereParts.push(Prisma.sql`a.id <> ${excludeId}`);
  }

  const whereSql = Prisma.join(whereParts, " AND ");

  // Fetch a bit over the cap so we can sort by max round in app, then slice.
  const fetchLimit = OTHER_PROGRESS_LIMIT * 3;
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      userId: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      jobTitle: string;
      companyName: string;
      bidAt: Date;
      interviewHistory: unknown;
    }>
  >`
    SELECT
      a.id,
      a."userId" AS "userId",
      u.email,
      u."firstName" AS "firstName",
      u."lastName" AS "lastName",
      a."jobTitle" AS "jobTitle",
      a."companyName" AS "companyName",
      a."bidAt" AS "bidAt",
      a.interview_history AS "interviewHistory"
    FROM resume_archives a
    JOIN "User" u ON u.id = a."userId"
    WHERE ${whereSql}
    ORDER BY a."bidAt" DESC
    LIMIT ${fetchLimit}
  `;

  const mapped = rows
    .map((r) => {
      const history = parseInterviewHistory(r.interviewHistory);
      const maxRound =
        history.length === 0 ? 0 : Math.max(...history.map((h) => h.round));
      if (maxRound < minCompletedRound) return null;
      const view = interviewHistoryView(history);
      return {
        id: r.id,
        profileId: r.userId,
        profileName: profileDisplayName(r.firstName, r.lastName, r.email),
        profileEmail: r.email,
        jobTitle: r.jobTitle,
        companyName: r.companyName,
        bidAt: r.bidAt.toISOString(),
        interviewHistory: view.interviewHistory,
        nextInterviewRound: view.nextInterviewRound,
        _maxRound: maxRound,
        _bidAtMs: r.bidAt.getTime(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  mapped.sort((a, b) => {
    if (b._maxRound !== a._maxRound) return b._maxRound - a._maxRound;
    return b._bidAtMs - a._bidAtMs;
  });

  const truncated = mapped.length > OTHER_PROGRESS_LIMIT;
  const items: OtherInterviewProgressItem[] = mapped
    .slice(0, OTHER_PROGRESS_LIMIT)
    .map(({ _maxRound, _bidAtMs, ...rest }) => {
      void _maxRound;
      void _bidAtMs;
      return rest;
    });

  if (opts?.adminId) {
    logger.info("admin.other-progress", "company peer search", {
      adminId: opts.adminId,
      company: companyName,
      minCompletedRound,
      excludeId: excludeId || null,
      resultCount: items.length,
      truncated,
    });
  }

  return {
    companyName,
    items,
    ...(truncated ? { truncated: true, limit: OTHER_PROGRESS_LIMIT } : {}),
  };
}
