import { Router } from "express";
import {
  chatCompletionsHandler,
  chatCompletionsStreamHandler,
  aiErrorHandler,
} from "../controllers/ai.controller";
import { requireAiAuth } from "../middleware/aiAuth";
import { aiChatRateLimiter } from "../middleware/rateLimit";
import { validateAiBody } from "../middleware/validateAi";
import { chatCompletionsSchema } from "../validators/ai.validator";

const router = Router();

router.use(requireAiAuth);
router.use(aiChatRateLimiter);

router.post(
  "/chat/completions",
  validateAiBody(chatCompletionsSchema),
  chatCompletionsHandler
);

router.post(
  "/chat/completions/stream",
  validateAiBody(chatCompletionsSchema),
  chatCompletionsStreamHandler
);

router.use(aiErrorHandler);

export default router;
