import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { env } from "../config/env";

const MAX_UPLOAD_BYTES = env.RESUME_MAX_FILE_SIZE_BYTES;

export const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 4,
  },
}).fields([
  { name: "avatar", maxCount: 1 },
  { name: "resumeTemplate", maxCount: 1 },
  { name: "promptFile", maxCount: 1 },
  // Compatibility aliases used by older/current frontend forms.
  { name: "prompt", maxCount: 1 },
  { name: "profilePrompt", maxCount: 1 },
  { name: "customPromptFile", maxCount: 1 },
]);

export function profileUploadHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    next();
    return;
  }

  profileUpload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }

    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE"
          ? "Uploaded file exceeds the maximum allowed size"
          : err.message;
      res.status(422).json({
        error: message,
        message,
        errors: { [err.field ?? "file"]: [message] },
      });
      return;
    }

    next(err);
  });
}

export type ProfileUploadFiles = {
  avatar?: Express.Multer.File[];
  resumeTemplate?: Express.Multer.File[];
  promptFile?: Express.Multer.File[];
  prompt?: Express.Multer.File[];
  profilePrompt?: Express.Multer.File[];
  customPromptFile?: Express.Multer.File[];
};

export function getProfileUploadFiles(req: Request): ProfileUploadFiles {
  const files = (req.files as ProfileUploadFiles | undefined) ?? {};
  const promptFile =
    files.promptFile ??
    files.prompt ??
    files.profilePrompt ??
    files.customPromptFile;

  return {
    ...files,
    ...(promptFile ? { promptFile } : {}),
  };
}
