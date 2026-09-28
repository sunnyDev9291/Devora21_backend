import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import passport from "./config/passport";
import authRoutes from "./routes/auth.routes";
import resumeRoutes from "./routes/resume.routes";
import aiRoutes from "./routes/ai.routes";
import jobRoutes from "./routes/job.routes";
import logsRoutes from "./routes/logs.routes";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/request-logger";
import { ALLOWED_FRONTEND_ORIGINS } from "./config/frontend";
import {
  claudeEnabled,
  aiMockEnabled,
  zyteEnabled,
  deepseekEnabled,
  backblazeEnabled,
} from "./config/env";
import { logger } from "./lib/logger";

const app = express();

app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_FRONTEND_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-User-Authorization",
      "X-User-Id",
    ],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(cookieParser());
app.use(passport.initialize());
app.use(requestLogger);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    claude: claudeEnabled,
    aiMock: aiMockEnabled,
    zyte: zyteEnabled,
    deepseek: deepseekEnabled,
    backblaze: backblazeEnabled,
  });
});

app.use("/auth", authRoutes);
app.use("/resume", resumeRoutes);
app.use("/ai", aiRoutes);
app.use("/jobs", jobRoutes);
app.use("/logs", logsRoutes);

app.use(errorHandler);

logger.info("app", "Express app configured (request logger + /logs live stream enabled)");

export default app;
