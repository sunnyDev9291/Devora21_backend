import { Request, Response, NextFunction } from "express";
import multer from "multer";
import { env } from "../config/env";

const MAX_UPLOAD_BYTES = env.RESUME_MAX_FILE_SIZE_BYTES;

export const profileUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 3,
  },
}).fields([
  { name: "avatar", maxCount: 1 },
  { name: "resumeTemplate", maxCount: 1 },
  { name: "promptFile", maxCount: 1 },
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
};

export function getProfileUploadFiles(req: Request): ProfileUploadFiles {
  return (req.files as ProfileUploadFiles | undefined) ?? {};
}
