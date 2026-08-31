import { Router } from "express";
import {
  registerHandler,
  loginHandler,
  logoutHandler,
  refreshHandler,
  meHandler,
  profileHandler,
  onboardingHandler,
  profilePromptHandler,
  profileResumeTemplateHandler,
  profileAvatarHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  verifyEmailHandler,
  resendVerificationHandler,
  googleAuthHandler,
  googleCallbackHandler,
  providersHandler,
  emailStatusHandler,
} from "../controllers/auth.controller";
import {
  createApiKeyHandler,
  listApiKeysHandler,
  revokeApiKeyHandler,
} from "../controllers/api-key.controller";
import { requireAuth, requireEmailVerified, requireResumeBuilder } from "../middleware/auth";
import { validateBody } from "../middleware/validate";
import { profileUploadHandler } from "../middleware/profileUpload";
import { authRateLimiter, onboardingRateLimiter } from "../middleware/rateLimit";
import {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  resendVerificationSchema,
} from "../validators/auth.validator";

const router = Router();

router.use(authRateLimiter);

router.post("/register", validateBody(registerSchema), registerHandler);
router.post("/login", validateBody(loginSchema), loginHandler);
router.post("/logout", logoutHandler);
router.post("/refresh", refreshHandler);
router.get("/me", requireAuth, meHandler);

router.get("/api-keys", requireAuth, listApiKeysHandler);
router.post("/api-keys", requireAuth, createApiKeyHandler);
router.delete("/api-keys/:id", requireAuth, revokeApiKeyHandler);

router.get("/profile/prompt", requireAuth, profilePromptHandler);
router.get("/profile/resume-template", requireAuth, requireResumeBuilder, profileResumeTemplateHandler);
router.get("/profile/avatar", requireAuth, profileAvatarHandler);
router.patch("/profile", requireAuth, profileUploadHandler, profileHandler);

router.post(
  "/onboarding",
  requireAuth,
  requireEmailVerified,
  onboardingRateLimiter,
  profileUploadHandler,
  onboardingHandler
);

router.get("/providers", providersHandler);
router.get("/email-status", emailStatusHandler);
router.get("/google", googleAuthHandler);
router.get("/google/callback", googleCallbackHandler);

router.post("/forgot-password", validateBody(forgotPasswordSchema), forgotPasswordHandler);
router.post("/reset-password", validateBody(resetPasswordSchema), resetPasswordHandler);
router.post("/verify-email", validateBody(verifyEmailSchema), verifyEmailHandler);
router.post(
  "/resend-verification",
  validateBody(resendVerificationSchema),
  resendVerificationHandler
);

export default router;
