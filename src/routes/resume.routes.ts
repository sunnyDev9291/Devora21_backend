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
import { requireAuth, requireEmailVerified, requireResumeBuilder } from "../middleware/auth";
import { requireRemoteDevice } from "../middleware/remote-device-auth";
import { resumeUpload } from "../middleware/upload";
import { validateBody } from "../middleware/validate";
import { resumeFromJobSchema } from "../validators/resume-from-job.validator";
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

/** Here vs remote deliver for an archived resume. */
router.post(
  "/archives/:id/deliver",
  requireAuth,
  requireResumeBuilder,
  validateBody(deliverArchiveSchema),
  deliverArchiveHandler
);

router.get(
  "/remote-deliveries",
  requireAuth,
  requireResumeBuilder,
  listRemoteDeliveriesHandler
);

router.get(
  "/remote-deliveries/:id/stream",
  requireAuth,
  requireResumeBuilder,
  streamRemoteDeliveryHandler
);

router.get(
  "/remote-deliveries/:id",
  requireAuth,
  requireResumeBuilder,
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
