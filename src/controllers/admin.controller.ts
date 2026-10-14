import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { getProfileUploadFiles } from "../middleware/profileUpload";
import { AppError } from "../middleware/errorHandler";
import { formatUserResponse } from "../utils/user";
import * as adminService from "../services/admin.service";

function parsePositiveInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

export async function listUsersHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const page = parsePositiveInt(req.query.page, 1);
    const limit = Math.min(100, parsePositiveInt(req.query.limit, 25));

    const result = await adminService.listUsers({ q, page, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function getUserHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }
    const user = await adminService.getAdminUser(id);
    res.json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

export async function patchUserHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }

    const files = getProfileUploadFiles(req);
    const user = await adminService.updateAdminUser(
      id,
      (req.body ?? {}) as Record<string, unknown>,
      {
        avatar: files.avatar?.[0],
        resumeTemplate: files.resumeTemplate?.[0],
        promptFile: files.promptFile?.[0],
      }
    );

    res.json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

export async function getUserPromptHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }
    const prompt = await adminService.getAdminUserPrompt(id);
    res.json(prompt);
  } catch (err) {
    next(err);
  }
}

export async function getUserResumeTemplateHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }
    const template = await adminService.getAdminUserResumeTemplate(id);
    res.json(template);
  } catch (err) {
    next(err);
  }
}

export async function getUserResumeTemplatePdfHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }
    const templateId =
      typeof req.query.templateId === "string" ? req.query.templateId.trim() : undefined;

    const pdf = await adminService.getAdminUserResumeTemplatePdf(id, templateId);
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

export async function putUserPromptHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const content =
      typeof body.content === "string"
        ? body.content
        : typeof body.customPrompt === "string"
          ? body.customPrompt
          : typeof body.promptContent === "string"
            ? body.promptContent
            : "";
    const fileName =
      typeof body.fileName === "string"
        ? body.fileName
        : typeof body.promptFileName === "string"
          ? body.promptFileName
          : undefined;

    const prompt = await adminService.putAdminUserPrompt(id, { content, fileName });
    res.json(prompt);
  } catch (err) {
    next(err);
  }
}

export async function deleteUserHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      throw new AppError(400, "User id is required");
    }
    if (!req.authUser?.id) {
      throw new AppError(401, "Authentication required");
    }

    const result = await adminService.deleteAdminUser(id, req.authUser.id);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
