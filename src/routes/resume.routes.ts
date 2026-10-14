import { Router } from "express";
import {
  archiveResumeHandler,
  downloadPublicResumeDocxHandler,
  downloadPublicResumePdfHandler,
  downloadResumeArchiveDocxHandler,
  downloadResumeArchivePdfHandler,
  handleUploadError,
  listResumeArchivesHandler,
  otherInterviewProgressHandler,
  getResumeArchiveJobDescriptionHandler,
  getResumeArchiveHandler,
  getInterviewHistoryHandler,
  recordInterviewRoundHandler,
  deleteInterviewRoundHandler,
  downloadResumeTemplatePdfHandler,
  resumeFromJobHandler,
  resumeFromJobStatusHandler,
  resumeRenderHandler,
  resumeTemplateStructureHandler,
} from "../controllers/resume.controller";
import {
  ackRemoteDeliveryHandler,
  createRemoteDeviceHandler,
  deliverArchiveHandler,
  getRemoteDeliveryHandler,
  listRemoteDeliveriesHandler,
  listRemoteDevicesHandler,
  pullRemoteQueueHandler,
  revokeRemoteDeviceHandler,
  setDefaultRemoteDeviceHandler,
  streamRemoteDeliveryHandler,
} from "../controllers/resume-remote.controller";
import {
  requireAuth,
  requireEmailVerified,
  requireResumeBuilder,
  requireSuperAdmin,
  type AuthenticatedRequest,
} from "../middleware/auth";
import type { Response, NextFunction } from "express";

/** Resume-builder users, or Super Admin (admin template preview fallback). */
function requireResumeBuilderOrSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.authUser?.isSuperAdmin) {
    next();
    return;
  }
  requireResumeBuilder(req, res, next);
}
import { requireRemoteDevice } from "../middleware/remote-device-auth";
import { resumeUpload } from "../middleware/upload";
import { validateBody } from "../middleware/validate";
import { resumeFromJobSchema } from "../validators/resume-from-job.validator";
import { resumeRenderSchema } from "../validators/resume-render.validator";
import {
  deleteInterviewRoundBodySchema,
  recordInterviewRoundSchema,
} from "../validators/interview-history.validator";
import {
  ackRemoteDeliverySchema,
  createRemoteDeviceSchema,
  deliverArchiveSchema,
} from "../validators/resume-remote.validator";

const router = Router();

/** Public share downloads — no auth (anyone with the link can download). */
router.get("/share/:id/pdf", downloadPublicResumePdfHandler);
router.get("/share/:id/docx", downloadPublicResumeDocxHandler);

/** Remote agent queue — auth via Bearer dvrd_… device secret (not user session). */
router.get("/remote-queue", requireRemoteDevice, pullRemoteQueueHandler);
router.post(
  "/remote-queue/:id/ack",
  requireRemoteDevice,
  validateBody(ackRemoteDeliverySchema),
  ackRemoteDeliveryHandler
);

/**
 * Authoritative render: stored template + structured content → DOCX + PDF archive.
 * Preview/download use /archives/{archiveId}/pdf|docx.
 */
router.post(
  "/render",
  requireAuth,
  requireResumeBuilder,
  validateBody(resumeRenderSchema),
  resumeRenderHandler
);

/** Original stored template → PDF as-is (no content fill). */
router.get(
  "/templates/:templateId/pdf",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  downloadResumeTemplatePdfHandler
);

/** Authoritative parse: jobs + bulletCount from styled DOCX (not AI draft). */
router.get(
  "/templates/active/structure",
  requireAuth,
  requireResumeBuilder,
  resumeTemplateStructureHandler
);
router.get(
  "/templates/:templateId/structure",
  requireAuth,
  requireResumeBuilder,
  resumeTemplateStructureHandler
);

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

/** Cross-profile same-company interview progress (Super Admin). Static before :id. */
router.get(
  "/archives/other-progress",
  requireAuth,
  requireSuperAdmin,
  otherInterviewProgressHandler
);
router.get(
  "/archives/peer-progress",
  requireAuth,
  requireSuperAdmin,
  otherInterviewProgressHandler
);

router.get(
  "/archives/:id/job-description",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  getResumeArchiveJobDescriptionHandler
);
router.get(
  "/archives/:id/jd",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  getResumeArchiveJobDescriptionHandler
);

router.get(
  "/archives/:id/docx",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  downloadResumeArchiveDocxHandler
);

router.get(
  "/archives/:id/pdf",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  downloadResumeArchivePdfHandler
);

router.get(
  "/archives/:id/interview-history",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  getInterviewHistoryHandler
);

router.post(
  "/archives/:id/interview-rounds",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  validateBody(recordInterviewRoundSchema),
  recordInterviewRoundHandler
);

/** Path form used by FE: DELETE …/interview-rounds/:round */
router.delete(
  "/archives/:id/interview-rounds/:round",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  deleteInterviewRoundHandler
);

/** Optional body alias: DELETE …/interview-rounds { "round": N } */
router.delete(
  "/archives/:id/interview-rounds",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  validateBody(deleteInterviewRoundBodySchema),
  deleteInterviewRoundHandler
);

/** Full archive item (FE last-resort JD fallback). Keep after static :id/* paths. */
router.get(
  "/archives/:id",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  getResumeArchiveHandler
);

/** Here vs remote deliver for an archived resume. */
router.post(
  "/archives/:id/deliver",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  validateBody(deliverArchiveSchema),
  deliverArchiveHandler
);

router.get(
  "/remote-deliveries",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  listRemoteDeliveriesHandler
);

router.get(
  "/remote-deliveries/:id/stream",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  streamRemoteDeliveryHandler
);

router.get(
  "/remote-deliveries/:id",
  requireAuth,
  requireResumeBuilderOrSuperAdmin,
  getRemoteDeliveryHandler
);

router.get(
  "/remote-devices",
  requireAuth,
  requireResumeBuilder,
  listRemoteDevicesHandler
);

router.post(
  "/remote-devices",
  requireAuth,
  requireResumeBuilder,
  validateBody(createRemoteDeviceSchema),
  createRemoteDeviceHandler
);

router.post(
  "/remote-devices/:id/default",
  requireAuth,
  requireResumeBuilder,
  setDefaultRemoteDeviceHandler
);

router.delete(
  "/remote-devices/:id",
  requireAuth,
  requireResumeBuilder,
  revokeRemoteDeviceHandler
);

export default router;
