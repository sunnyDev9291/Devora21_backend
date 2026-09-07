import { Request, Response, NextFunction } from "express";
import * as authService from "../services/auth.service";
import * as onboardingService from "../services/onboarding.service";
import { getProfileUploadFiles } from "../middleware/profileUpload";
import { setAuthCookies, clearAuthCookies, REFRESH_TOKEN_COOKIE } from "../utils/cookies";
import { AuthenticatedRequest, ACCESS_TOKEN_COOKIE } from "../middleware/auth";
import { verifyAccessToken } from "../lib/jwt";
import { AppError } from "../middleware/errorHandler";
import { env, googleOAuthEnabled, emailEnabled, emailVerificationRequired } from "../config/env";
import passport, { GoogleOAuthProfile, toOAuthProfile } from "../config/passport";
import { formatUserResponse } from "../utils/user";
import {
  buildOAuthRedirect,
  parseOAuthStartQuery,
  signOAuthState,
  verifyOAuthState,
  type OAuthFlowState,
} from "../utils/oauth-state";

export async function registerHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user, tokens } = await authService.register(req.body);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.status(201).json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

export async function loginHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { user, tokens } = await authService.login(req.body);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

export async function logoutHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    let userId: string | undefined;

    const accessToken = req.cookies?.[ACCESS_TOKEN_COOKIE];
    if (accessToken) {
      try {
        userId = verifyAccessToken(accessToken).sub;
      } catch {
        // ignore invalid access token during logout
      }
    }

    await authService.logout(req.cookies?.[REFRESH_TOKEN_COOKIE], userId);
    clearAuthCookies(res);
    res.json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
}

export async function refreshHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const tokens = await authService.refreshTokens(req.cookies?.[REFRESH_TOKEN_COOKIE]);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.json({ message: "Token refreshed" });
  } catch (err) {
    next(err);
  }
}

export async function meHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required");
    }
    const user = await authService.getCurrentUser(req.authUser.id);
    res.json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

function buildProfileInput(req: AuthenticatedRequest): onboardingService.ProfileMultipartInput {
  const files = getProfileUploadFiles(req);

  return {
    files: {
      avatar: files.avatar?.[0],
      resumeTemplate: files.resumeTemplate?.[0],
      promptFile: files.promptFile?.[0],
    },
  };
}

export async function profileHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required");
    }

    const input: onboardingService.ProfileMultipartInput = {
      ...buildProfileInput(req),
      ...onboardingService.parseProfileBody(
        (req.body ?? {}) as Record<string, unknown>
      ),
    };

    const user = await onboardingService.updateUserProfile(req.authUser.id, input);
    res.json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

export async function onboardingHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required");
    }

    const input: onboardingService.ProfileMultipartInput = {
      ...buildProfileInput(req),
      ...onboardingService.parseOnboardingMultipart(req.body as Record<string, unknown>),
    };

    const user = await onboardingService.completeOnboarding(req.authUser.id, input);
    res.json({ user: formatUserResponse(user) });
  } catch (err) {
    next(err);
  }
}

export async function profilePromptHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required");
    }

    const prompt = await onboardingService.getUserPrompt(req.authUser.id);
    res.json(prompt);
  } catch (err) {
    next(err);
  }
}

export async function profileResumeTemplateHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required");
    }

    const template = await onboardingService.getUserResumeTemplate(req.authUser.id);
    res.json(template);
  } catch (err) {
    next(err);
  }
}

export async function profileAvatarHandler(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.authUser) {
      throw new AppError(401, "Authentication required");
    }

    const avatar = await onboardingService.getUserAvatar(req.authUser.id);
    res.setHeader("Content-Type", avatar.contentType);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(avatar.buffer);
  } catch (err) {
    next(err);
  }
}

export async function forgotPasswordHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await authService.forgotPassword(req.body);
    res.json({
      message: "If an account with that email exists, a reset link has been sent",
    });
  } catch (err) {
    next(err);
  }
}

export async function resetPasswordHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await authService.resetPassword(req.body);
    res.json({ message: "Password reset successfully" });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmailHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await authService.verifyEmail(req.body);
    res.json({ message: "Email verified successfully" });
  } catch (err) {
    next(err);
  }
}

export async function resendVerificationHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    await authService.resendVerificationEmail(req.body.email);
    res.json({
      message: "If an account with that email exists and is unverified, a verification link has been sent",
    });
  } catch (err) {
    next(err);
  }
}

export function providersHandler(_req: Request, res: Response): void {
  res.json({
    google: {
      enabled: googleOAuthEnabled,
      startUrl: `${env.API_BASE_URL}/auth/google`,
      callbackUrl: `${env.API_BASE_URL}/auth/google/callback`,
    },
    frontendSuccessUrl: `${env.FRONTEND_URL}/dashboard`,
    frontendFailureUrl: `${env.FRONTEND_URL}/login`,
  });
}

export function emailStatusHandler(_req: Request, res: Response): void {
  res.json({
    enabled: emailEnabled,
    required: emailVerificationRequired,
    from: env.SMTP_FROM,
    verifyUrlPattern: `${env.FRONTEND_URL}/verify-email?token={token}`,
    resetUrlPattern: `${env.FRONTEND_URL}/reset-password?token={token}`,
  });
}

function redirectToFlowTarget(
  res: Response,
  flow: OAuthFlowState,
  result: string,
  directUrl?: string,
  extraParams?: Record<string, string>
): void {
  if (directUrl) {
    res.redirect(directUrl);
    return;
  }

  res.redirect(buildOAuthRedirect(flow.complete_url, result, extraParams));
}

async function clearExistingSession(req: Request, res: Response): Promise<void> {
  let userId: string | undefined;

  const accessToken = req.cookies?.[ACCESS_TOKEN_COOKIE];
  if (accessToken) {
    try {
      userId = verifyAccessToken(accessToken).sub;
    } catch {
      // ignore invalid access token
    }
  }

  await authService.logout(req.cookies?.[REFRESH_TOKEN_COOKIE], userId);
  clearAuthCookies(res);
}

export async function googleAuthHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!googleOAuthEnabled) {
    res.status(503).json({ error: "Google OAuth is not configured", message: "Google OAuth is not configured" });
    return;
  }

  try {
    const flow = parseOAuthStartQuery(req.query as Record<string, unknown>);

    if (flow.intent === "signup") {
      await clearExistingSession(req, res);
    }

    const signedState = signOAuthState(flow);
    const authOptions: {
      scope: string[];
      state: string;
      prompt?: string;
    } = {
      scope: ["profile", "email"],
      state: signedState,
    };

    if (flow.prompt) {
      authOptions.prompt = flow.prompt;
    }

    passport.authenticate("google", authOptions)(req, res, next);
  } catch (err) {
    if (err instanceof Error) {
      next(new AppError(400, err.message));
      return;
    }
    next(err);
  }
}

export function googleCallbackHandler(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!googleOAuthEnabled) {
    res.status(503).json({ error: "Google OAuth is not configured", message: "Google OAuth is not configured" });
    return;
  }

  passport.authenticate("google", { session: false }, async (err: Error | null, profile?: GoogleOAuthProfile) => {
    let flow: OAuthFlowState;

    try {
      flow = verifyOAuthState(typeof req.query.state === "string" ? req.query.state : undefined);
    } catch {
      return res.redirect(
        buildOAuthRedirect(`${env.FRONTEND_URL}/auth/oauth/complete`, "oauth_error", {
          message: "Invalid OAuth state",
        })
      );
    }

    if (err || !profile) {
      return res.redirect(
        buildOAuthRedirect(flow.complete_url, "oauth_error", {
          message: err?.message ?? "Google authentication failed",
        })
      );
    }

    const oauthProfile = toOAuthProfile(profile);

    try {
      if (flow.intent === "signup") {
        clearAuthCookies(res);

        try {
          await authService.createGoogleUser(oauthProfile);
          return redirectToFlowTarget(
            res,
            flow,
            "signup_success",
            flow.signup_success_url
          );
        } catch (signupErr) {
          if (signupErr instanceof AppError && signupErr.statusCode === 409) {
            return redirectToFlowTarget(
              res,
              flow,
              "google_already_registered",
              flow.signup_exists_url
            );
          }
          throw signupErr;
        }
      }

      try {
        const { tokens } = await authService.loginGoogleUser(oauthProfile);
        setAuthCookies(res, tokens.accessToken, tokens.refreshToken);

        if (flow.login_success_url) {
          return res.redirect(flow.login_success_url);
        }

        return res.redirect(
          buildOAuthRedirect(flow.complete_url, "login_success", { next: "/dashboard" })
        );
      } catch (loginErr) {
        if (loginErr instanceof AppError && loginErr.statusCode === 404) {
          if (flow.login_fallback_url) {
            return res.redirect(flow.login_fallback_url);
          }

          return res.redirect(
            buildOAuthRedirect(flow.complete_url, "oauth_error", {
              message: "No account found",
            })
          );
        }
        throw loginErr;
      }
    } catch (callbackErr) {
      return next(callbackErr);
    }
  })(req, res, next);
}
