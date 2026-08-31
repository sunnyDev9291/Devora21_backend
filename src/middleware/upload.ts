import multer from "multer";
import { env } from "../config/env";

export const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.RESUME_MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const isDocx =
      name.endsWith(".docx") ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    if (!isDocx) {
      cb(new Error("INVALID_FILE_TYPE"));
      return;
    }

    cb(null, true);
  },
});
