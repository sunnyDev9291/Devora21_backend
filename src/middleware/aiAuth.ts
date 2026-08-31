import { Request, Response, NextFunction } from "express";
import { env, isProduction } from "../config/env";
import { resolveAuth } from "./auth-session";
import type { AuthenticatedRequest } from "./auth";

/**
 * Allow either:
 * - User auth via Bearer dv21_… / session cookies (sets req.authUser), or
 * - AI_INTERNAL_API_KEY (BFF). User may come from cookies, or later from body.userId / X-User-Id.
 */
export async function requireAiAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  const isInternal =
    Boolean(env.AI_INTERNAL_API_KEY) && token === env.AI_INTERNAL_API_KEY;

  try {
    const resolved = await resolveAuth(req, res);
    if (resolved) {
      const { user, method } = resolved;
      if (!user.resumeBuilderEnabled) {
        res.status(403).json({
          error: "Resume builder access not enabled",
          message: "Resume builder access not enabled",
        });
        return;
      }

      req.authMethod = method;
      req.authUser = {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        resumeBuilderEnabled: user.resumeBuilderEnabled,
      };
      next();
      return;
    }
  } catch {
    // fall through
  }

  if (isInternal) {
    req.authMethod = "internal";
    next();
    return;
  }

  if (isProduction && !env.AI_INTERNAL_API_KEY) {
    res.status(503).json({ error: "AI auth is not configured" });
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

/** @deprecated Use requireAiAuth — kept for any external imports. */
export function requireAiInternalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  void requireAiAuth(req as AuthenticatedRequest, res, next);
}
