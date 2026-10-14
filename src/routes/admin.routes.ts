import { Router } from "express";
import { requireAuth, requireSuperAdmin } from "../middleware/auth";
import { profileUploadHandler } from "../middleware/profileUpload";
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
  adminResumeAnalyticsHandler,
  adminResumeOverviewAnalyticsHandler,
  adminResumeCompareAnalyticsHandler,
  adminListResumesHandler,
  adminOtherInterviewProgressHandler,
  adminResumePdfHandler,
  adminResumeDocxHandler,
} from "../controllers/admin-resume.controller";

const router = Router();

router.use(requireAuth, requireSuperAdmin);

router.get("/users", listUsersHandler);
router.get("/users/:id", getUserHandler);
router.patch("/users/:id", profileUploadHandler, patchUserHandler);
router.delete("/users/:id", deleteUserHandler);
router.post("/users/:id/delete", deleteUserHandler);
router.get("/users/:id/prompt", getUserPromptHandler);
router.put("/users/:id/prompt", putUserPromptHandler);
router.get("/users/:id/resume-template/pdf", getUserResumeTemplatePdfHandler);
router.get("/users/:id/resume-template", getUserResumeTemplateHandler);

// Resume analytics & management (order: static paths before :id)
router.get("/resumes/analytics/overview", adminResumeOverviewAnalyticsHandler);
router.get("/resumes/analytics/compare", adminResumeCompareAnalyticsHandler);
router.get("/resumes/analytics", adminResumeAnalyticsHandler);
router.get("/resumes/other-progress", adminOtherInterviewProgressHandler);
router.get("/resumes", adminListResumesHandler);
router.get("/resumes/:id/pdf", adminResumePdfHandler);
router.get("/resumes/:id/docx", adminResumeDocxHandler);

export default router;
