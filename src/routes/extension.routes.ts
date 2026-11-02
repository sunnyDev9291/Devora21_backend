import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import {
  extensionMeHandler,
  syncApplicationQaHandler,
  listOwnSessionsHandler,
  getOwnSessionHandler,
  patchOwnSessionHandler,
  deleteOwnSessionHandler,
} from "../controllers/application-qa.controller";
import {
  syncApplicationQaSchema,
  patchApplicationQaSessionSchema,
} from "../validators/application-qa.validator";
import {
  createCaptureHandler,
  listCapturesHandler,
  getCaptureHandler,
  deleteCaptureHandler,
} from "../controllers/application-capture.controller";
import { createApplicationCaptureSchema } from "../validators/application-capture.validator";

const router = Router();

router.use(requireAuth);

router.get("/me", extensionMeHandler);

/** Apply-gate screenshot uploads (primary extension flow). */
router.post(
  "/application-captures",
  validateBody(createApplicationCaptureSchema),
  createCaptureHandler
);
router.get("/application-captures", listCapturesHandler);
router.get("/application-captures/:id", getCaptureHandler);
router.delete("/application-captures/:id", deleteCaptureHandler);

/** Legacy live Q&A sync (kept for compatibility). */
router.post(
  "/application-qa/sync",
  validateBody(syncApplicationQaSchema),
  syncApplicationQaHandler
);
router.get("/application-qa/sessions", listOwnSessionsHandler);
router.get("/application-qa/sessions/:id", getOwnSessionHandler);
router.patch(
  "/application-qa/sessions/:id",
  validateBody(patchApplicationQaSessionSchema),
  patchOwnSessionHandler
);
router.delete("/application-qa/sessions/:id", deleteOwnSessionHandler);

export default router;
