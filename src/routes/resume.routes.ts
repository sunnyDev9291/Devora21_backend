import { Router } from "express";
import {
  archiveResumeHandler,
  downloadPublicResumeDocxHandler,
  downloadPublicResumePdfHandler,
  downloadResumeArchiveDocxHandler,
  downloadResumeArchivePdfHandler,
  handleUploadError,
  listResumeArchivesHandler,
  resumeFromJobHandler,
  resumeFromJobStatusHandler,
} from "../controllers/resume.controller";
import { requireAuth, requireEmailVerified, requireResumeBuilder } from "../middleware/auth";
import { resumeUpload } from "../middleware/upload";
import { validateBody } from "../middleware/validate";
import { resumeFromJobSchema } from "../validators/resume-from-job.validator";

const router = Router();

/** Public share downloads — no auth (anyone with the link can download). */
router.get("/share/:id/pdf", downloadPublicResumePdfHandler);
router.get("/share/:id/docx", downloadPublicResumeDocxHandler);

/** Async: job URL → scrape → AI → DOCX → PDF. Returns jobId immediately. */
router.post(
  "/from-job",
  requireAuth,
  requireResumeBuilder,
  validateBody(resumeFromJobSchema),
  resumeFromJobHandler
);

/** Poll resume generation status / result */
router.get(
  "/from-job/:jobId",
  requireAuth,
  requireResumeBuilder,
  resumeFromJobStatusHandler
);

router.post(
  "/archive",
  requireAuth,
  requireEmailVerified,
  requireResumeBuilder,
  (req, res, next) => {
    resumeUpload.single("resume")(req, res, (err) => {
      if (err) {
        handleUploadError(err, req, res, next);
        return;
      }
      next();
    });
  },
  archiveResumeHandler
);

router.get("/archives", requireAuth, requireResumeBuilder, listResumeArchivesHandler);

router.get(
  "/archives/:id/docx",
  requireAuth,
  requireResumeBuilder,
  downloadResumeArchiveDocxHandler
);

router.get(
  "/archives/:id/pdf",
  requireAuth,
  requireResumeBuilder,
  downloadResumeArchivePdfHandler
);

export default router;
