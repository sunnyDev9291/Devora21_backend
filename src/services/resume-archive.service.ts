import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";
import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { sanitizeArchiveFileName, toPdfDisplayName } from "../utils/sanitize";
import {
  buildArchiveWhereSql,
  hasArchiveListFilters,
  normalizeArchiveListFilters,
  parseBidAt,
  type ArchiveListFilters,
} from "../utils/archive-filters";
import { convertDocxBufferToPdf } from "./resume-convert.service";
import { readUserFile } from "./profile-storage.service";
import {
  backblazeEnabled,
  createBackblazeDownloadUrl,
  downloadBackblazeFileByUrl,
  uploadDocxToBackblaze,
  uploadPdfToBackblaze,
} from "./backblaze.service";

/** Public (no-auth) Devora share URL — fallback if B2 signing fails. */
export function buildPublicShareUrl(archiveId: string, kind: "pdf" | "docx"): string {
  return `${env.API_BASE_URL.replace(/\/$/, "")}/resume/share/${archiveId}/${kind}`;
}

export interface ArchiveResumeInput {
  userId: string;
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
        jobTitle: input.jobTitle,
        companyName: input.companyName,
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

  if (!hasArchiveListFilters(normalized)) {
    const rows = await prisma.resumeArchive.findMany({
      where: { userId },
      orderBy: { bidAt: "desc" },
    });
    return rows.map(formatListItem);
  }

  const whereClause = buildArchiveWhereSql(userId, normalized);
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
  const fileName = kind === "docx" ? archive.resumeFileName : archive.pdfFileName;
  const contentType =
    kind === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";
  const disposition = kind === "docx" ? "attachment" : "inline";

  const cloudUrl = kind === "docx" ? archive.docxUrl : archive.pdfUrl;
  if (cloudUrl) {
    // Proxy through this API — browser fetch cannot follow cross-origin
    // redirects to Backblaze (CORS → "Failed to fetch").
    const buffer = await downloadBackblazeFileByUrl(cloudUrl);
    return { buffer, fileName, contentType, disposition };
  }

  // Legacy local fallback for older archives
  const storageKey = kind === "docx" ? archive.docxStorageKey : archive.pdfStorageKey;
  if (storageKey) {
    try {
      const buffer = await readUserFile(storageKey);
      return { buffer, fileName, contentType, disposition };
    } catch {
      throw new AppError(404, kind === "docx" ? "Resume archive not found" : "Resume PDF not found");
    }
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
