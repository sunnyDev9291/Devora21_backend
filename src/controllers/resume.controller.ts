import { Response, NextFunction } from "express";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import {
  archiveResume,
  deleteInterviewRound,
  getInterviewHistoryForUser,
  getResumeArchiveFilePublic,
  getResumeArchiveForUser,
  getResumeArchiveJobDescription,
  listResumeArchives,
  openResumeArchiveFileStream,
  recordInterviewRound,
} from "../services/resume-archive.service";
import type {
  DeleteInterviewRoundBodyInput,
  RecordInterviewRoundInput,
} from "../validators/interview-history.validator";
import {
  enqueueResumeFromJob,
  getResumeFromJobStatus,
} from "../services/resume-from-job.service";
import { renderResumeFromRequest } from "../services/resume-render.service";
import {
  getResumeTemplatePdf,
  getResumeTemplateStructure,
} from "../services/resume-template.service";
import type { ArchiveListFilters } from "../utils/archive-filters";
import { parseExactFlag } from "../utils/archive-filters";
import { AppError } from "../middleware/errorHandler";
import { AuthenticatedRequest } from "../middleware/auth";
import { findOtherInterviewProgress } from "../services/admin-resume.service";
import type { ResumeFromJobInput } from "../validators/resume-from-job.validator";
import type { ResumeRenderInput } from "../validators/resume-render.validator";

function optionalQueryParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseArchiveListFilters(query: AuthenticatedRequest["query"]): ArchiveListFilters {
  const jobTitle =
    optionalQueryParam(query.jobTitle) || optionalQueryParam(query.title);

  // JD filter aliases — FE lean Saved Resumes may send jd= or jobDescription=
  const jd =
    optionalQueryParam(query.jd) ||
    optionalQueryParam(query.jobDescription) ||
    optionalQueryParam(query.job_description);

  // Integrated keyword aliases (same server-side field union as q)
  const q =
    optionalQueryParam(query.q) ||
    optionalQueryParam(query.search) ||
    optionalQueryParam(query.query);

  return {
    company: optionalQueryParam(query.company),
    jobTitle,
    jd,
    from: optionalQueryParam(query.from),
    to: optionalQueryParam(query.to),
    q,
    exact: parseExactFlag(query.exact),
  };
}

/** FE Saved Resumes: includeJobDescription=false and/or fields=lean */
function parseLeanListFlag(query: AuthenticatedRequest["query"]): boolean {
  const fields = optionalQueryParam(query.fields)?.toLowerCase();
  if (fields === "lean") return true;

  const raw = query.includeJobDescription;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (v === "false" || v === "0" || v === "no") return true;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    const v = raw[0].trim().toLowerCase();
    if (v === "false" || v === "0" || v === "no") return true;
  }
  return false;
}

function contentDisposition(type: string, fileName: string): string {
  const safeName = fileName.replace(/["\\]/g, "_");
  return `${type}; filename="${safeName}"`;
}

export async function resumeFromJobHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const accepted = await enqueueResumeFromJob(userId, req.body as ResumeFromJobInput);
    res.status(202).json(accepted);
  } catch (err) {
    next(err);
  }
}

export async function resumeRenderHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const result = await renderResumeFromRequest(
      userId,
      req.body as ResumeRenderInput
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

/** Original template DOCX → PDF as-is (no fill) for WYSIWYG preview. */
export async function downloadResumeTemplatePdfHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const templateId = String(req.params.templateId ?? "").trim();
    if (!templateId) {
      throw new AppError(400, "templateId is required");
    }

    let pdf: Awaited<ReturnType<typeof getResumeTemplatePdf>>;
    try {
      pdf = await getResumeTemplatePdf({ userId, templateId });
    } catch (err) {
      // Super Admin FE fallback: preview another user's template by id.
      if (
        err instanceof AppError &&
        err.statusCode === 404 &&
        req.authUser?.isSuperAdmin
      ) {
        const { prisma } = await import("../lib/prisma");
        const row = await prisma.resumeTemplate.findFirst({
          where: { id: templateId },
          select: { userId: true },
        });
        if (!row) throw err;
        pdf = await getResumeTemplatePdf({
          userId: row.userId,
          templateId,
        });
      } else {
        throw err;
      }
    }

    const safeName = pdf.pdfFileName.replace(/["\\]/g, "_");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    res.setHeader("Cache-Control", "private, no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("ETag", `"${pdf.templateId}"`);
    res.setHeader("Content-Length", String(pdf.buffer.length));
    res.status(200).send(pdf.buffer);
  } catch (err) {
    next(err);
  }
}

/** Mode-1 skeleton: company/role/dates + exact bulletCount per job from DOCX styles. */
export async function resumeTemplateStructureHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const templateId = String(req.params.templateId ?? "").trim() || undefined;
    const structure = await getResumeTemplateStructure({ userId, templateId });
    res.status(200).json(structure);
  } catch (err) {
    next(err);
  }
}

export async function resumeFromJobStatusHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const jobId = String(req.params.jobId ?? "").trim();
    if (!jobId) {
      throw new AppError(400, "jobId is required");
    }

    const status = await getResumeFromJobStatus(userId, jobId);
    res.status(200).json(status);
  } catch (err) {
    next(err);
  }
}

export async function archiveResumeHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const jobTitle = String(req.body?.jobTitle ?? "").trim();
    const companyName = String(req.body?.companyName ?? "").trim();
    const jobDescription = String(req.body?.jobDescription ?? "").trim();
    const datetime = String(req.body?.datetime ?? "").trim();
    const resumeFileName = String(req.body?.resumeFileName ?? "").trim();
    const file = req.file;

    // jobTitle = job posting title from the form (not the AI resume headline).
    if (!jobTitle || !companyName) {
      throw new AppError(400, "jobTitle and companyName are required");
    }

    if (!datetime) {
      throw new AppError(400, "datetime is required");
    }

    if (!resumeFileName) {
      throw new AppError(400, "resumeFileName is required");
    }

    if (!file) {
      throw new AppError(400, "resume DOCX file is required");
    }

    const result = await archiveResume({
      userId,
      jobTitle,
      companyName,
      jobDescription,
      datetime,
      resumeFileName,
      fileBuffer: file.buffer,
    });

    res.status(200).json({
      id: result.id,
      resumeName: result.resumeName,
      pdfFileName: result.pdfFileName,
      docxUrl: result.docxUrl,
      pdfUrl: result.pdfUrl,
      ...(result.pdfBase64 ? { pdfBase64: result.pdfBase64 } : {}),
    });
  } catch (err) {
    next(err);
  }
}

export async function listResumeArchivesHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const lean = parseLeanListFlag(req.query);
    const items = await listResumeArchives(
      userId,
      parseArchiveListFilters(req.query),
      { lean }
    );

    res.status(200).json({ items });
  } catch (err) {
    next(err);
  }
}

/**
 * Twin of GET /admin/resumes/other-progress for FE fallback.
 * Super Admin only — cross-profile company interview discovery.
 */
export async function otherInterviewProgressHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser?.isSuperAdmin) {
      throw new AppError(403, "Super Admin access required");
    }
    const result = await findOtherInterviewProgress(
      req.query as Record<string, unknown>,
      { adminId: req.authUser.id }
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

function archiveCaller(req: AuthenticatedRequest): {
  userId: string;
  isSuperAdmin: boolean;
} {
  const userId = req.authUser?.id;
  if (!userId) {
    throw new AppError(401, "Authentication required");
  }
  return {
    userId,
    isSuperAdmin: Boolean(req.authUser?.isSuperAdmin),
  };
}

export async function getResumeArchiveJobDescriptionHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "").trim();
    const result = await getResumeArchiveJobDescription(caller, archiveId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getResumeArchiveHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "").trim();
    const item = await getResumeArchiveForUser(caller, archiveId);
    res.status(200).json(item);
  } catch (err) {
    next(err);
  }
}

export async function getInterviewHistoryHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "").trim();
    const result = await getInterviewHistoryForUser(caller, archiveId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function recordInterviewRoundHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "").trim();
    const body = req.body as RecordInterviewRoundInput;
    const result = await recordInterviewRound(caller, archiveId, body.action);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function deleteInterviewRoundHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "").trim();
    const fromPath = Array.isArray(req.params.round)
      ? req.params.round[0]
      : req.params.round;
    const fromBody = (req.body as DeleteInterviewRoundBodyInput | undefined)
      ?.round;
    const round =
      fromPath !== undefined && String(fromPath).trim() !== ""
        ? String(fromPath).trim()
        : fromBody;
    if (round === undefined || round === null || String(round).trim() === "") {
      throw new AppError(400, "round is required");
    }
    const result = await deleteInterviewRound(caller, archiveId, round);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function downloadResumeArchiveDocxHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "");
    const file = await openResumeArchiveFileStream(caller, archiveId, "docx");

    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", contentDisposition("attachment", file.fileName));
    if (file.contentLength) {
      res.setHeader("Content-Length", String(file.contentLength));
    }
    res.status(200);
    await pipeline(file.stream as NodeJS.ReadableStream, res);
  } catch (err) {
    next(err);
  }
}

export async function downloadResumeArchivePdfHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const caller = archiveCaller(req);
    const archiveId = String(req.params.id ?? "");
    const file = await openResumeArchiveFileStream(caller, archiveId, "pdf");

    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", contentDisposition("inline", file.fileName));
    if (file.contentLength) {
      res.setHeader("Content-Length", String(file.contentLength));
    }
    res.status(200);
    await pipeline(file.stream as NodeJS.ReadableStream, res);
  } catch (err) {
    next(err);
  }
}

/** Public PDF download — no auth (share link for other domains). */
export async function downloadPublicResumePdfHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const archiveId = String(req.params.id ?? "");
    const file = await getResumeArchiveFilePublic(archiveId, "pdf");

    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", contentDisposition("attachment", file.fileName));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).send(file.buffer);
  } catch (err) {
    next(err);
  }
}

/** Public DOCX download — no auth (share link for other domains). */
export async function downloadPublicResumeDocxHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const archiveId = String(req.params.id ?? "");
    const file = await getResumeArchiveFilePublic(archiveId, "docx");

    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", contentDisposition("attachment", file.fileName));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.status(200).send(file.buffer);
  } catch (err) {
    next(err);
  }
}

export function handleUploadError(
  err: Error,
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "File too large. Maximum size is 10 MB." });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }

  if (err.message === "INVALID_FILE_TYPE") {
    res.status(422).json({ error: "resume must be a valid DOCX file" });
    return;
  }

  next(err);
}
