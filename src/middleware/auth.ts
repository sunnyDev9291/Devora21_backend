import { Request, Response, NextFunction } from "express";
import { emailVerificationRequired } from "../config/env";
import { resolveAuth, type AuthMethod } from "./auth-session";

export interface AuthenticatedRequest extends Request {
  authUser?: {
    id: string;
    email: string;
    emailVerified: boolean;
    resumeBuilderEnabled: boolean;
  };
  /** How the request was authenticated. */
  authMethod?: AuthMethod;
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({ error: message, message });
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const resolved = await resolveAuth(req, res);

    if (!resolved) {
      unauthorized(res, "Authentication required");
      return;
    }

    const { user, method } = resolved;
    req.authMethod = method;
    req.authUser = {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      resumeBuilderEnabled: user.resumeBuilderEnabled,
    };
    next();
  } catch {
    unauthorized(res, "Invalid or expired session");
  }
}

export function requireEmailVerified(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.authUser) {
    unauthorized(res, "Authentication required");
    return;
  }

  // API key possession is enough — skip email verification for programmatic clients.
  if (req.authMethod === "apiKey") {
    next();
    return;
  }

  if (!emailVerificationRequired) {
    next();
    return;
  }

  if (!req.authUser.emailVerified) {
    res.status(403).json({
      error: "Email verification required",
      message: "Email verification required",
    });
    return;
  }

  next();
}

export function requireResumeBuilder(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.authUser) {
    unauthorized(res, "Authentication required");
    return;
  }

  if (!req.authUser.resumeBuilderEnabled) {
    res.status(403).json({
      error: "Resume builder access not enabled",
      message: "Resume builder access not enabled",
    });
    return;
  }

  next();
}

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../utils/cookies";
