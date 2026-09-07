import { Response, NextFunction } from "express";
import { pipeline } from "node:stream/promises";
import multer from "multer";
import {
  archiveResume,
  getResumeArchiveFilePublic,
  listResumeArchives,
  openResumeArchiveFileStream,
} from "../services/resume-archive.service";
import {
  enqueueResumeFromJob,
  getResumeFromJobStatus,
} from "../services/resume-from-job.service";
import type { ArchiveListFilters } from "../utils/archive-filters";
import { parseExactFlag } from "../utils/archive-filters";
import { AppError } from "../middleware/errorHandler";
import { AuthenticatedRequest } from "../middleware/auth";
import type { ResumeFromJobInput } from "../validators/resume-from-job.validator";

function optionalQueryParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseArchiveListFilters(query: AuthenticatedRequest["query"]): ArchiveListFilters {
  const jobTitle =
    optionalQueryParam(query.jobTitle) || optionalQueryParam(query.title);

  return {
    company: optionalQueryParam(query.company),
    jobTitle,
    jd: optionalQueryParam(query.jd),
    from: optionalQueryParam(query.from),
    to: optionalQueryParam(query.to),
    q: optionalQueryParam(query.q),
    exact: parseExactFlag(query.exact),
  };
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

    const items = await listResumeArchives(userId, parseArchiveListFilters(req.query));

    res.status(200).json({ items });
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
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const archiveId = String(req.params.id ?? "");
    const file = await openResumeArchiveFileStream(userId, archiveId, "docx");

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
    const userId = req.authUser?.id;
    if (!userId) {
      throw new AppError(401, "Authentication required");
    }

    const archiveId = String(req.params.id ?? "");
    const file = await openResumeArchiveFileStream(userId, archiveId, "pdf");

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
