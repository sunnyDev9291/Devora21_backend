import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { AppError } from "../middleware/errorHandler";
import * as adminResumeService from "../services/admin-resume.service";

export async function adminResumeAnalyticsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await adminResumeService.getAdminResumeAnalytics(
      req.query as Record<string, unknown>
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminResumeOverviewAnalyticsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await adminResumeService.getAdminResumeOverviewAnalytics(
      req.query as Record<string, unknown>
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminResumeCompareAnalyticsHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await adminResumeService.getAdminResumeCompareAnalytics(
      req.query as Record<string, unknown>
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminListResumesHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await adminResumeService.listAdminResumes(
      req.query as Record<string, unknown>
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminOtherInterviewProgressHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const result = await adminResumeService.findOtherInterviewProgress(
      req.query as Record<string, unknown>,
      { adminId: req.authUser?.id }
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function adminResumePdfHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Resume id is required");

    const file = await adminResumeService.streamAdminResumeFile(id, "pdf");
    const safeName = file.fileName.replace(/["\\]/g, "_");
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${safeName}"`
    );
    res.setHeader("Cache-Control", "private, no-store");
    if (file.contentLength !== undefined) {
      res.setHeader("Content-Length", String(file.contentLength));
    }
    file.stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

export async function adminResumeDocxHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw new AppError(400, "Resume id is required");

    const file = await adminResumeService.streamAdminResumeFile(id, "docx");
    const safeName = file.fileName.replace(/["\\]/g, "_");
    res.setHeader("Content-Type", file.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}"`
    );
    res.setHeader("Cache-Control", "private, no-store");
    if (file.contentLength !== undefined) {
      res.setHeader("Content-Length", String(file.contentLength));
    }
    file.stream.pipe(res);
  } catch (err) {
    next(err);
  }
}
