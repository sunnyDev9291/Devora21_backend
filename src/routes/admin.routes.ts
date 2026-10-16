import { Router } from "express";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";
import { profileUploadHandler } from "../middleware/profileUpload";
import { validateBody } from "../middleware/validate";
import { adminGatewayVerifyRateLimiter } from "../middleware/rateLimit";
import {
  listUsersHandler,
  getUserHandler,
  patchUserHandler,
  getUserPromptHandler,
  putUserPromptHandler,
  getUserResumeTemplateHandler,
  getUserResumeTemplatePdfHandler,
  deleteUserHandler,
} from "../controllers/admin.controller";
import {
  getGatewayCredentialsHandler,
  putGatewayCredentialsHandler,
  verifyGatewayCredentialsHandler,
} from "../controllers/admin-gateway.controller";
import {
  adminResumeAnalyticsHandler,
  adminResumeOverviewAnalyticsHandler,
  adminResumeCompareAnalyticsHandler,
  adminListResumesHandler,
  adminOtherInterviewProgressHandler,
  adminResumePdfHandler,
  adminResumeDocxHandler,
} from "../controllers/admin-resume.controller";
import {
  acceptQueryAccessToken,
  acceptApplicationQaStreamTicket,
  adminListQaOwnersHandler,
  adminListQaSessionsHandler,
  adminGetQaSessionHandler,
  adminDeleteQaSessionHandler,
  adminStreamQaHandler,
  adminStreamQaTicketHandler,
} from "../controllers/application-qa.controller";
import {
  putGatewayCredentialsSchema,
  verifyGatewayCredentialsSchema,
} from "../validators/admin-gateway.validator";

const router = Router();

// EventSource cannot set Authorization — allow ?access_token= / ?token= / ?ticket=
router.use(acceptQueryAccessToken);
router.use(acceptApplicationQaStreamTicket);
router.use(requireAuth, requireSuperAdmin);

/** Per–Super Admin operator gateway credentials (FE /super-admin second gate). */
router.get("/gateway-credentials", getGatewayCredentialsHandler);
router.put(
  "/gateway-credentials",
  validateBody(putGatewayCredentialsSchema),
  putGatewayCredentialsHandler
);
router.post(
  "/gateway-credentials/verify",
  adminGatewayVerifyRateLimiter,
  validateBody(verifyGatewayCredentialsSchema),
  verifyGatewayCredentialsHandler
);

router.get("/users", listUsersHandler);
router.get("/users/:id", getUserHandler);
router.patch("/users/:id", profileUploadHandler, patchUserHandler);
router.delete("/users/:id", deleteUserHandler);
router.post("/users/:id/delete", deleteUserHandler);
router.get("/users/:id/prompt", getUserPromptHandler);
router.put("/users/:id/prompt", putUserPromptHandler);
router.get("/users/:id/resume-template/pdf", getUserResumeTemplatePdfHandler);
router.get("/users/:id/resume-template", getUserResumeTemplateHandler);

// Application Q&A recordings (Chrome extension) — Super Admin only
router.get("/application-qa/owners", adminListQaOwnersHandler);
router.get("/application-qa/sessions", adminListQaSessionsHandler);
/** Live SSE: ticket + stream (register before :id). */
router.post("/application-qa/stream-ticket", adminStreamQaTicketHandler);
router.get("/application-qa/stream", adminStreamQaHandler);
router.get("/application-qa/sessions/:id", adminGetQaSessionHandler);
router.delete("/application-qa/sessions/:id", adminDeleteQaSessionHandler);

// Resume analytics & management (order: static paths before :id)
router.get("/resumes/analytics/overview", adminResumeOverviewAnalyticsHandler);
router.get("/resumes/analytics/compare", adminResumeCompareAnalyticsHandler);
router.get("/resumes/analytics", adminResumeAnalyticsHandler);
router.get("/resumes/other-progress", adminOtherInterviewProgressHandler);
router.get("/resumes", adminListResumesHandler);
router.get("/resumes/:id/pdf", adminResumePdfHandler);
router.get("/resumes/:id/docx", adminResumeDocxHandler);

export default router;
