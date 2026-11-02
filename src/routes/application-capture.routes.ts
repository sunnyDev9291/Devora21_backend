import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import {
  createCaptureHandler,
  listCapturesHandler,
  getCaptureHandler,
  deleteCaptureHandler,
} from "../controllers/application-capture.controller";
import { createApplicationCaptureSchema } from "../validators/application-capture.validator";

/**
 * Frontend (cookie/session) + any Bearer client.
 * Extension also mounts the same handlers under /extension/application-captures.
 */
const router = Router();

router.use(requireAuth);

router.post(
  "/",
  validateBody(createApplicationCaptureSchema),
  createCaptureHandler
);
router.get("/", listCapturesHandler);
router.get("/:id", getCaptureHandler);
router.delete("/:id", deleteCaptureHandler);

export default router;
