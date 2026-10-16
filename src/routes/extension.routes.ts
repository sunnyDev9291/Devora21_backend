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

const router = Router();

router.use(requireAuth);

router.get("/me", extensionMeHandler);
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
