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
} as const;

/** Public (no-auth) Devora share URL — fallback if B2 signing fails. */
export function buildPublicShareUrl(archiveId: string, kind: "pdf" | "docx"): string {
  return `${env.API_BASE_URL.replace(/\/$/, "")}/resume/share/${archiveId}/${kind}`;
}

export interface ArchiveResumeInput {
  userId: string;
  /** Job posting title (role applied to) — not the AI-generated resume headline. */
  jobTitle: string;
  companyName: string;
  jobDescription: string;
  datetime: string;
  resumeFileName: string;
  fileBuffer: Buffer;
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

export interface ResumeArchiveListItem {
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
}): ResumeArchiveListItem {
  return {
    id: archive.id,
    bidAt: archive.bidAt.toISOString(),
    jobTitle: archive.jobTitle,
    companyName: archive.companyName,
    jobDescription: archive.jobDescription ?? "",
    resumeFileName: archive.resumeFileName,
    pdfFileName: archive.pdfFileName,
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
  const archiveId = uuidv4();
  const companyName = normalizeCompanyQuery(input.companyName);
  if (!companyName) {
    throw new AppError(400, "companyName is required");
  }
  const jobTitle = normalizeJobTitleQuery(input.jobTitle);
  if (!jobTitle) {
    throw new AppError(400, "jobTitle is required");
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

  try {
    await prisma.resumeArchive.create({
      data: {
        id: archiveId,
        userId: input.userId,
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
      },
    });
  } catch (err) {
    console.error("Failed to create resume archive record:", err);
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

export async function listResumeArchives(
  userId: string,
  filters: ArchiveListFilters = {}
): Promise<ResumeArchiveListItem[]> {
  const normalized = normalizeArchiveListFilters(filters);

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
      "pdfUrl"
    FROM resume_archives
    ${whereClause}
    ORDER BY "bidAt" DESC
    ${limitClause}
  `;

  return rows.map(formatListItem);
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
  userId: string,
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
    where: { id: archiveId, userId },
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

  throw new AppError(404, kind === "docx" ? "Resume archive not found" : "Resume PDF not found");
}

export async function getResumeArchiveFile(
  userId: string,
  archiveId: string,
  kind: "docx" | "pdf"
): Promise<{
  buffer: Buffer;
  fileName: string;
  contentType: string;
  disposition: string;
}> {
  const archive = await prisma.resumeArchive.findFirst({
    where: { id: archiveId, userId },
  });

  if (!archive) {
    throw new AppError(404, "Resume archive not found");
  }

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
