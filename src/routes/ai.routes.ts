import { Router } from "express";
import {
  chatCompletionsHandler,
  chatCompletionsStreamHandler,
  listClaudeModelsHandler,
  aiErrorHandler,
} from "../controllers/ai.controller";
import { requireAiAuth } from "../middleware/aiAuth";
import { aiChatRateLimiter } from "../middleware/rateLimit";
import { validateAiBody } from "../middleware/validateAi";
import { chatCompletionsSchema } from "../validators/ai.validator";

const router = Router();

router.use(requireAiAuth);

/** FE model dropdown — auth only, not subject to chat rate limit. */
router.get("/models", listClaudeModelsHandler);
router.get("/claude/models", listClaudeModelsHandler);
router.get("/models/claude", listClaudeModelsHandler);

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
