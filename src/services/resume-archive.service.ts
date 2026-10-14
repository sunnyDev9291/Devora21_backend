import { v4 as uuidv4 } from "uuid";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { sanitizeArchiveFileName, toPdfDisplayName } from "../utils/sanitize";
import {
  buildArchiveWhereSql,
  COMPANY_TYPEAHEAD_LIMIT,
  hasArchiveListFilters,
  isCompanyTypeahead,
  normalizeArchiveListFilters,
  normalizeCompanyQuery,
  normalizeJobTitleQuery,
  parseBidAt,
  type ArchiveListFilters,
} from "../utils/archive-filters";
import { convertDocxBufferToPdf } from "./resume-convert.service";
import { readUserFile } from "./profile-storage.service";
import {
  backblazeEnabled,
  createBackblazeDownloadUrl,
  downloadBackblazeFileByUrl,
  openBackblazeReadStream,
  uploadDocxToBackblaze,
  uploadPdfToBackblaze,
} from "./backblaze.service";
import {
  interviewHistoryDbValue,
  interviewHistoryView,
  parseInterviewHistory,
  type InterviewHistoryView,
  type InterviewRoundRecord,
} from "../lib/interview-history";
import {
  archiveAccessWhere,
  auditArchiveAccess,
  findAccessibleArchive,
  type ArchiveAccessCaller,
} from "../lib/archive-access";

export type { ArchiveAccessCaller };

const ARCHIVE_LIST_SELECT = {
  id: true,
  bidAt: true,
  jobTitle: true,
  companyName: true,
  jobDescription: true,
  resumeFileName: true,
  pdfFileName: true,
  docxUrl: true,
  pdfUrl: true,
  interviewHistory: true,
} as const;

/** Lean list: never SELECT jobDescription body. */
const ARCHIVE_LEAN_HAS_JD_SQL = Prisma.sql`(
  "jobDescription" IS NOT NULL AND length(btrim("jobDescription")) > 0
)`;

/** Public (no-auth) Devora share URL — fallback if B2 signing fails. */
export function buildPublicShareUrl(archiveId: string, kind: "pdf" | "docx"): string {
  return `${env.API_BASE_URL.replace(/\/$/, "")}/resume/share/${archiveId}/${kind}`;
}

/** Persist values for ResumeArchive.generationMethod. */
export type ResumeGenerationMethod = "web_ui" | "one_click_api";

export interface ArchiveResumeInput {
  userId: string;
  /** Job posting title (role applied to) — not the AI-generated resume headline. */
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  datetime: string;
  resumeFileName: string;
  fileBuffer: Buffer;
  /** When set, overwrite this archive's stored DOCX/PDF (re-apply / re-render). */
  archiveId?: string;
  /** Template used to produce this archive. */
  templateId?: string | null;
  /** Defaults to web_ui. */
  generationMethod?: ResumeGenerationMethod;
}

export interface ArchiveResumeResult {
  id: string;
  resumeName: string;
  pdfFileName: string;
  docxUrl: string;
  pdfUrl: string;
  /** In-memory only — not persisted on disk. Kept for legacy /archive clients. */
  pdfBase64?: string;
}

export interface ResumeArchiveListItem extends InterviewHistoryView {
  id: string;
  bidAt: string;
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  resumeFileName: string;
  pdfFileName: string;
  docxUrl?: string;
  pdfUrl?: string;
}

/** Saved Resumes tab fast path — no JD body in payload. */
export interface ResumeArchiveLeanListItem extends InterviewHistoryView {
  id: string;
  bidAt: string;
  jobTitle: string;
  companyName: string;
  resumeFileName: string;
  pdfFileName: string;
  hasJobDescription: boolean;
}

export type ListResumeArchivesOptions = {
  /** When true: omit jobDescription bodies; include hasJobDescription. */
  lean?: boolean;
};

function assertDocxBuffer(buffer: Buffer): void {
  if (buffer.length < 1024) {
    throw new AppError(422, "resume must be a valid DOCX file");
  }

  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new AppError(422, "resume must be a valid DOCX file");
  }

  if (!buffer.includes(Buffer.from("word/document.xml"))) {
    throw new AppError(422, "resume must be a valid DOCX file");
  }
}

function formatListItem(archive: {
  id: string;
  bidAt: Date;
  jobTitle: string;
  companyName: string;
  jobDescription: string | null;
  resumeFileName: string;
  pdfFileName: string;
  docxUrl?: string | null;
  pdfUrl?: string | null;
  interviewHistory?: unknown;
}): ResumeArchiveListItem {
  const history = interviewHistoryView(archive.interviewHistory);
  return {
    id: archive.id,
    bidAt: archive.bidAt.toISOString(),
    jobTitle: archive.jobTitle,
    companyName: archive.companyName,
    jobDescription: archive.jobDescription ?? "",
    resumeFileName: archive.resumeFileName,
    pdfFileName: archive.pdfFileName,
    interviewHistory: history.interviewHistory,
    nextInterviewRound: history.nextInterviewRound,
    ...(archive.docxUrl ? { docxUrl: archive.docxUrl } : {}),
    ...(archive.pdfUrl ? { pdfUrl: archive.pdfUrl } : {}),
  };
}

async function withSignedDownloadUrls(archive: {
  id: string;
  docxUrl?: string | null;
  pdfUrl?: string | null;
}): Promise<{ docxUrl?: string; pdfUrl?: string }> {
  const out: { docxUrl?: string; pdfUrl?: string } = {};
  if (archive.pdfUrl) {
    try {
      out.pdfUrl = await createBackblazeDownloadUrl(archive.pdfUrl);
    } catch {
      out.pdfUrl = buildPublicShareUrl(archive.id, "pdf");
    }
  }
  if (archive.docxUrl) {
    try {
      out.docxUrl = await createBackblazeDownloadUrl(archive.docxUrl);
    } catch {
      out.docxUrl = buildPublicShareUrl(archive.id, "docx");
    }
  }
  return out;
}

/**
 * Convert DOCX→PDF in memory, upload both files to Backblaze only
 * (nothing written under storage/archives). Persist docxUrl + pdfUrl.
 *
 * `jobTitle` must be the job posting title (user form / scrape), never the AI resume title.
 */
export async function archiveResume(input: ArchiveResumeInput): Promise<ArchiveResumeResult> {
  assertDocxBuffer(input.fileBuffer);

  if (!backblazeEnabled) {
    throw new AppError(
      503,
      "Backblaze B2 is not configured. Set B2_KEY_ID, B2_APPLICATION_KEY, and B2_BUCKET."
    );
  }

  const resumeName = sanitizeArchiveFileName(input.resumeFileName);
  const pdfFileName = toPdfDisplayName(resumeName);
  const bidAt = parseBidAt(input.datetime);
  const companyName = normalizeCompanyQuery(input.companyName);
  if (!companyName) {
    throw new AppError(400, "companyName is required");
  }
  const jobTitle = normalizeJobTitleQuery(input.jobTitle);
  if (!jobTitle) {
    throw new AppError(400, "jobTitle is required");
  }

  let archiveId = input.archiveId?.trim() || "";
  if (archiveId) {
    const existing = await prisma.resumeArchive.findFirst({
      where: { id: archiveId, userId: input.userId },
      select: { id: true },
    });
    if (!existing) {
      throw new AppError(404, "Resume archive not found");
    }
  } else {
    archiveId = uuidv4();
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await convertDocxBufferToPdf(input.fileBuffer);
  } catch (err) {
    throw err;
  }

  const [docxUpload, pdfUpload] = await Promise.all([
    uploadDocxToBackblaze({
      userId: input.userId,
      archiveId,
      docxFileName: resumeName,
      docxBuffer: input.fileBuffer,
    }),
    uploadPdfToBackblaze({
      userId: input.userId,
      archiveId,
      pdfFileName,
      pdfBuffer,
    }),
  ]);

  const generationMethod: ResumeGenerationMethod =
    input.generationMethod === "one_click_api" ? "one_click_api" : "web_ui";

  try {
    await prisma.resumeArchive.upsert({
      where: { id: archiveId },
      create: {
        id: archiveId,
        userId: input.userId,
        templateId: input.templateId ?? null,
        bidAt,
        jobTitle,
        companyName,
        jobDescription: input.jobDescription || null,
        resumeFileName: resumeName,
        pdfFileName,
        docxStorageKey: null,
        pdfStorageKey: null,
        docxUrl: docxUpload.docxUrl,
        pdfUrl: pdfUpload.pdfUrl,
        generationMethod,
      },
      update: {
        templateId: input.templateId ?? undefined,
        bidAt,
        jobTitle,
        companyName,
        jobDescription: input.jobDescription || null,
        resumeFileName: resumeName,
        pdfFileName,
        docxUrl: docxUpload.docxUrl,
        pdfUrl: pdfUpload.pdfUrl,
        generationMethod,
      },
    });
  } catch (err) {
    console.error("Failed to save resume archive record:", err);
    throw new AppError(500, "Failed to save application record");
  }

  const signed = await withSignedDownloadUrls({
    id: archiveId,
    docxUrl: docxUpload.docxUrl,
    pdfUrl: pdfUpload.pdfUrl,
  });

  return {
    id: archiveId,
    resumeName,
    pdfFileName,
    docxUrl: signed.docxUrl || docxUpload.docxUrl,
    pdfUrl: signed.pdfUrl || pdfUpload.pdfUrl,
    pdfBase64: pdfBuffer.toString("base64"),
  };
}

async function listResumeArchivesLean(
  userId: string,
  filters: ArchiveListFilters
): Promise<ResumeArchiveLeanListItem[]> {
  const whereClause = buildArchiveWhereSql(userId, filters);
  const limitClause = isCompanyTypeahead(filters)
    ? Prisma.sql`LIMIT ${COMPANY_TYPEAHEAD_LIMIT}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      bidAt: Date;
      jobTitle: string;
      companyName: string;
      resumeFileName: string;
      pdfFileName: string;
      hasJobDescription: boolean;
      interviewHistory: unknown;
    }>
  >`
    SELECT
      id,
      "bidAt",
      "jobTitle",
      "companyName",
      "resumeFileName",
      "pdfFileName",
      ${ARCHIVE_LEAN_HAS_JD_SQL} AS "hasJobDescription",
      interview_history AS "interviewHistory"
    FROM resume_archives
    ${whereClause}
    ORDER BY "bidAt" DESC
    ${limitClause}
  `;

  return rows.map((r) => {
    const history = interviewHistoryView(r.interviewHistory);
    return {
      id: r.id,
      bidAt: r.bidAt.toISOString(),
      jobTitle: r.jobTitle,
      companyName: r.companyName,
      resumeFileName: r.resumeFileName,
      pdfFileName: r.pdfFileName,
      hasJobDescription: Boolean(r.hasJobDescription),
      interviewHistory: history.interviewHistory,
      nextInterviewRound: history.nextInterviewRound,
    };
  });
}

export async function listResumeArchives(
  userId: string,
  filters: ArchiveListFilters = {},
  options: ListResumeArchivesOptions = {}
): Promise<ResumeArchiveListItem[] | ResumeArchiveLeanListItem[]> {
  const normalized = normalizeArchiveListFilters(filters);

  if (options.lean) {
    return listResumeArchivesLean(userId, normalized);
  }

  // Fast path: no filters, or only company/jobTitle via Prisma (uses userId indexes).
  const prismaFastPath =
    !normalized.jd && !normalized.from && !normalized.to && !normalized.q;

  if (!hasArchiveListFilters(normalized) || prismaFastPath) {
    const rows = await prisma.resumeArchive.findMany({
      where: {
        userId,
        ...(normalized.company
          ? {
              companyName: normalized.exact
                ? { equals: normalized.company, mode: "insensitive" as const }
                : { contains: normalized.company, mode: "insensitive" as const },
            }
          : {}),
        ...(normalized.jobTitle
          ? {
              jobTitle: {
                contains: normalized.jobTitle,
                mode: "insensitive" as const,
              },
            }
          : {}),
      },
      orderBy: { bidAt: "desc" },
      ...(isCompanyTypeahead(normalized)
        ? { take: COMPANY_TYPEAHEAD_LIMIT }
        : {}),
      select: ARCHIVE_LIST_SELECT,
    });
    return rows.map(formatListItem);
  }

  const whereClause = buildArchiveWhereSql(userId, normalized);
  const limitClause = isCompanyTypeahead(normalized)
    ? Prisma.sql`LIMIT ${COMPANY_TYPEAHEAD_LIMIT}`
    : Prisma.empty;

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      bidAt: Date;
      jobTitle: string;
      companyName: string;
      jobDescription: string | null;
      resumeFileName: string;
      pdfFileName: string;
      docxUrl: string | null;
      pdfUrl: string | null;
      interviewHistory: unknown;
    }>
  >`
    SELECT
      id,
      "bidAt",
      "jobTitle",
      "companyName",
      "jobDescription",
      "resumeFileName",
      "pdfFileName",
      "docxUrl",
      "pdfUrl",
      interview_history AS "interviewHistory"
    FROM resume_archives
    ${whereClause}
    ORDER BY "bidAt" DESC
    ${limitClause}
  `;

  return rows.map(formatListItem);
}

function toCaller(
  userIdOrCaller: string | ArchiveAccessCaller,
  isSuperAdmin?: boolean
): ArchiveAccessCaller {
  if (typeof userIdOrCaller === "string") {
    return { userId: userIdOrCaller, isSuperAdmin: Boolean(isSuperAdmin) };
  }
  return {
    userId: userIdOrCaller.userId,
    isSuperAdmin: Boolean(userIdOrCaller.isSuperAdmin),
  };
}

/** On-demand JD for Saved Resumes “View description” / “Use JD”. */
export async function getResumeArchiveJobDescription(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  isSuperAdmin?: boolean
): Promise<{ id: string; jobDescription: string }> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  const row = await findAccessibleArchive(archiveId, caller, {
    jobDescription: true,
  });

  auditArchiveAccess({
    action: "job-description",
    callerUserId: caller.userId,
    isSuperAdmin: caller.isSuperAdmin,
    archiveId: row.id,
    ownerProfileId: row.userId,
  });

  return {
    id: row.id,
    jobDescription: row.jobDescription?.trim() ? row.jobDescription : "",
  };
}

/** Full archive item for owner (FE last-resort fallback). */
export async function getResumeArchiveForUser(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  isSuperAdmin?: boolean
): Promise<ResumeArchiveListItem> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  const row = await findAccessibleArchive(archiveId, caller, ARCHIVE_LIST_SELECT);
  return formatListItem(row);
}

export type RecordInterviewAction = "round" | "other";

export type RecordInterviewRoundResult = InterviewHistoryView & {
  id: string;
  bidAt: string;
  /** Set when action=round; null for other (no history change). */
  recordedRound: number | null;
  recordedAt: string | null;
};

/**
 * Record the next interview round before/with a Round-N download.
 * action=other is a no-op (history unchanged) so FE can call uniformly if desired.
 * Super Admin may record on any archive; history stays on the shared archive row.
 */
export async function recordInterviewRound(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  action: RecordInterviewAction,
  isSuperAdmin?: boolean
): Promise<RecordInterviewRoundResult> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  if (action !== "round" && action !== "other") {
    throw new AppError(400, 'action must be "round" or "other"');
  }

  const existing = await findAccessibleArchive(archiveId, caller, {
    bidAt: true,
    interviewHistory: true,
  });

  const current = interviewHistoryView(existing.interviewHistory);
  if (action === "other") {
    auditArchiveAccess({
      action: "interview-round-other",
      callerUserId: caller.userId,
      isSuperAdmin: caller.isSuperAdmin,
      archiveId: existing.id,
      ownerProfileId: existing.userId,
    });
    return {
      id: existing.id,
      bidAt: existing.bidAt.toISOString(),
      interviewHistory: current.interviewHistory,
      nextInterviewRound: current.nextInterviewRound,
      recordedRound: null,
      recordedAt: null,
    };
  }

  const where = archiveAccessWhere(archiveId, caller);

  // Serialize concurrent Round clicks with a transaction + fresh read.
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.resumeArchive.findFirst({
      where,
      select: {
        id: true,
        userId: true,
        bidAt: true,
        interviewHistory: true,
      },
    });
    if (!row) {
      throw new AppError(404, "Resume archive not found");
    }

    const history = parseInterviewHistory(row.interviewHistory);
    const round =
      history.length === 0 ? 1 : Math.max(...history.map((r) => r.round)) + 1;
    const downloadedAt = new Date().toISOString();
    const next: InterviewRoundRecord[] = [
      ...history,
      { round, downloadedAt },
    ];

    await tx.resumeArchive.update({
      where: { id: row.id },
      data: { interviewHistory: interviewHistoryDbValue(next) },
    });

    return {
      id: row.id,
      ownerProfileId: row.userId,
      bidAt: row.bidAt.toISOString(),
      interviewHistory: next,
      nextInterviewRound: round + 1,
      recordedRound: round,
      recordedAt: downloadedAt,
    };
  });

  auditArchiveAccess({
    action: "interview-round",
    callerUserId: caller.userId,
    isSuperAdmin: caller.isSuperAdmin,
    archiveId: result.id,
    ownerProfileId: result.ownerProfileId,
    meta: { recordedRound: result.recordedRound },
  });

  return {
    id: result.id,
    bidAt: result.bidAt,
    interviewHistory: result.interviewHistory,
    nextInterviewRound: result.nextInterviewRound,
    recordedRound: result.recordedRound,
    recordedAt: result.recordedAt,
  };
}

export async function getInterviewHistoryForUser(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  isSuperAdmin?: boolean
): Promise<
  InterviewHistoryView & {
    id: string;
    bidAt: string;
    companyName: string;
    jobTitle: string;
  }
> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  const row = await findAccessibleArchive(archiveId, caller, {
    bidAt: true,
    companyName: true,
    jobTitle: true,
    interviewHistory: true,
  });

  const history = interviewHistoryView(row.interviewHistory);
  return {
    id: row.id,
    bidAt: row.bidAt.toISOString(),
    companyName: row.companyName,
    jobTitle: row.jobTitle,
    interviewHistory: history.interviewHistory,
    nextInterviewRound: history.nextInterviewRound,
  };
}

export type DeleteInterviewRoundResult = InterviewHistoryView & {
  id: string;
  bidAt: string;
  deletedRound: number;
};

/**
 * Remove one recorded interview round (mistake correction).
 * Preferred policy: keep remaining round numbers as-is (gaps allowed).
 * nextInterviewRound = max(remaining) + 1, or 1 if empty.
 * Does not touch bidAt / Applied.
 */
export async function deleteInterviewRound(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  roundRaw: number | string,
  isSuperAdmin?: boolean
): Promise<DeleteInterviewRoundResult> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  const round = Number(roundRaw);
  if (!Number.isInteger(round) || round < 1) {
    throw new AppError(400, "round must be a positive integer");
  }

  const existing = await findAccessibleArchive(archiveId, caller, {
    bidAt: true,
    interviewHistory: true,
  });

  const history = parseInterviewHistory(existing.interviewHistory);
  if (!history.some((r) => r.round === round)) {
    throw new AppError(404, "Interview round not found");
  }

  const where = archiveAccessWhere(archiveId, caller);
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.resumeArchive.findFirst({
      where,
      select: {
        id: true,
        userId: true,
        bidAt: true,
        interviewHistory: true,
      },
    });
    if (!row) {
      throw new AppError(404, "Resume archive not found");
    }

    const current = parseInterviewHistory(row.interviewHistory);
    if (!current.some((r) => r.round === round)) {
      throw new AppError(404, "Interview round not found");
    }

    // No renumber: keep remaining round numbers; gaps are allowed.
    const next = current.filter((r) => r.round !== round);
    const nextInterviewRound =
      next.length === 0 ? 1 : Math.max(...next.map((r) => r.round)) + 1;

    await tx.resumeArchive.update({
      where: { id: row.id },
      data: {
        interviewHistory:
          next.length > 0 ? interviewHistoryDbValue(next) : [],
      },
    });

    return {
      id: row.id,
      ownerProfileId: row.userId,
      bidAt: row.bidAt.toISOString(),
      interviewHistory: next,
      nextInterviewRound,
      deletedRound: round,
    };
  });

  auditArchiveAccess({
    action: "interview-round-delete",
    callerUserId: caller.userId,
    isSuperAdmin: caller.isSuperAdmin,
    archiveId: result.id,
    ownerProfileId: result.ownerProfileId,
    meta: { deletedRound: result.deletedRound },
  });

  return {
    id: result.id,
    bidAt: result.bidAt,
    interviewHistory: result.interviewHistory,
    nextInterviewRound: result.nextInterviewRound,
    deletedRound: result.deletedRound,
  };
}

async function loadArchiveFile(
  archive: {
    resumeFileName: string;
    pdfFileName: string;
    docxUrl: string | null;
    pdfUrl: string | null;
    docxStorageKey: string | null;
    pdfStorageKey: string | null;
  },
  kind: "docx" | "pdf"
): Promise<{
  buffer: Buffer;
  fileName: string;
  contentType: string;
  disposition: string;
}> {
  const meta = archiveFileMeta(archive, kind);
  const cloudUrl = kind === "docx" ? archive.docxUrl : archive.pdfUrl;
  if (cloudUrl) {
    const buffer = await downloadBackblazeFileByUrl(cloudUrl);
    return { buffer, ...meta };
  }

  const storageKey = kind === "docx" ? archive.docxStorageKey : archive.pdfStorageKey;
  if (storageKey) {
    try {
      const buffer = await readUserFile(storageKey);
      return { buffer, ...meta };
    } catch {
      throw new AppError(404, kind === "docx" ? "Resume archive not found" : "Resume PDF not found");
    }
  }

  throw new AppError(404, kind === "docx" ? "Resume archive not found" : "Resume PDF not found");
}

function archiveFileMeta(
  archive: { resumeFileName: string; pdfFileName: string },
  kind: "docx" | "pdf"
): { fileName: string; contentType: string; disposition: string } {
  return {
    fileName: kind === "docx" ? archive.resumeFileName : archive.pdfFileName,
    contentType:
      kind === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/pdf",
    disposition: kind === "docx" ? "attachment" : "inline",
  };
}

export async function openResumeArchiveFileStream(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  kind: "docx" | "pdf",
  isSuperAdmin?: boolean
): Promise<{
  stream: NodeJS.ReadableStream;
  fileName: string;
  contentType: string;
  disposition: string;
  contentLength?: number;
}> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  const archive = await findAccessibleArchive(archiveId, caller, {
    resumeFileName: true,
    pdfFileName: true,
    docxUrl: true,
    pdfUrl: true,
    docxStorageKey: true,
    pdfStorageKey: true,
  });

  auditArchiveAccess({
    action: kind === "pdf" ? "download-pdf" : "download-docx",
    callerUserId: caller.userId,
    isSuperAdmin: caller.isSuperAdmin,
    archiveId: archive.id,
    ownerProfileId: archive.userId,
  });

  const meta = archiveFileMeta(archive, kind);
  const cloudUrl = kind === "docx" ? archive.docxUrl : archive.pdfUrl;
  if (cloudUrl) {
    const opened = await openBackblazeReadStream(cloudUrl);
    return { ...opened, ...meta };
  }

  const storageKey = kind === "docx" ? archive.docxStorageKey : archive.pdfStorageKey;
  if (storageKey) {
    const { Readable } = await import("node:stream");
    const buffer = await readUserFile(storageKey);
    return {
      stream: Readable.from(buffer),
      contentLength: buffer.length,
      ...meta,
    };
  }

  throw new AppError(404, kind === "docx" ? "Resume archive not found" : "Resume PDF not found");
}

export async function getResumeArchiveFile(
  userIdOrCaller: string | ArchiveAccessCaller,
  archiveId: string,
  kind: "docx" | "pdf",
  isSuperAdmin?: boolean
): Promise<{
  buffer: Buffer;
  fileName: string;
  contentType: string;
  disposition: string;
}> {
  const caller = toCaller(userIdOrCaller, isSuperAdmin);
  const archive = await findAccessibleArchive(archiveId, caller, {
    resumeFileName: true,
    pdfFileName: true,
    docxUrl: true,
    pdfUrl: true,
    docxStorageKey: true,
    pdfStorageKey: true,
  });

  return loadArchiveFile(archive, kind);
}

/** Public share download — anyone with the archive UUID link can download (no auth). */
export async function getResumeArchiveFilePublic(
  archiveId: string,
  kind: "docx" | "pdf"
): Promise<{
  buffer: Buffer;
  fileName: string;
  contentType: string;
  disposition: string;
}> {
  const archive = await prisma.resumeArchive.findFirst({
    where: { id: archiveId },
  });

  if (!archive) {
    throw new AppError(404, "Resume archive not found");
  }

  return loadArchiveFile(archive, kind);
}

/**
 * Super Admin download — any user's archive (authorize via requireSuperAdmin).
 */
export async function openAdminResumeArchiveFileStream(
  archiveId: string,
  kind: "docx" | "pdf"
): Promise<{
  stream: NodeJS.ReadableStream;
  fileName: string;
  contentType: string;
  disposition: string;
  contentLength?: number;
}> {
  const archive = await prisma.resumeArchive.findFirst({
    where: { id: archiveId },
    select: {
      resumeFileName: true,
      pdfFileName: true,
      docxUrl: true,
      pdfUrl: true,
      docxStorageKey: true,
      pdfStorageKey: true,
    },
  });

  if (!archive) {
    throw new AppError(404, "Resume archive not found");
  }

  const meta = archiveFileMeta(archive, kind);
  const cloudUrl = kind === "docx" ? archive.docxUrl : archive.pdfUrl;
  if (cloudUrl) {
    const opened = await openBackblazeReadStream(cloudUrl);
    return { ...opened, ...meta };
  }

  const storageKey = kind === "docx" ? archive.docxStorageKey : archive.pdfStorageKey;
  if (storageKey) {
    const { Readable } = await import("node:stream");
    const buffer = await readUserFile(storageKey);
    return {
      stream: Readable.from(buffer),
      contentLength: buffer.length,
      ...meta,
    };
  }

  throw new AppError(
    404,
    kind === "docx" ? "Resume archive not found" : "Resume PDF not found"
  );
}
