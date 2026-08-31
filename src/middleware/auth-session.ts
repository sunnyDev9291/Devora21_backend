import type { Request, Response } from "express";
import type { User } from "@prisma/client";
import { env } from "../config/env";
import { verifyAccessToken } from "../lib/jwt";
import * as authService from "../services/auth.service";
import * as apiKeyService from "../services/api-key.service";
import { setAuthCookies, ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../utils/cookies";

export type AuthMethod = "apiKey" | "session" | "internal";

export type ResolvedAuth = {
  user: User;
  method: AuthMethod;
};

async function findUserByAccessToken(accessToken: string): Promise<User | null> {
  try {
    const payload = verifyAccessToken(accessToken);
    return authService.findUserById(payload.sub);
  } catch {
    return null;
  }
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  const token = header.slice(7).trim();
  return token || undefined;
}

export async function resolveAuthenticatedUser(
  req: Request,
  res: Response
): Promise<User | null> {
  const resolved = await resolveAuth(req, res);
  return resolved?.user ?? null;
}

/** Resolve user and whether they authenticated via API key or session cookies. */
export async function resolveAuth(
  req: Request,
  res: Response
): Promise<ResolvedAuth | null> {
  const bearer = extractBearerToken(req);
  // Skip AI internal key here — it is not a user API key; fall through to cookies.
  if (bearer && bearer !== env.AI_INTERNAL_API_KEY) {
    const apiUser = await apiKeyService.findUserByApiKey(bearer);
    if (apiUser) {
      return { user: apiUser, method: "apiKey" };
    }

    // Also accept a user JWT as Bearer (some BFFs forward the access token).
    const jwtUser = await findUserByAccessToken(bearer);
    if (jwtUser) {
      return { user: jwtUser, method: "session" };
    }
  }

  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  const accessToken = cookies?.[ACCESS_TOKEN_COOKIE];
  if (accessToken) {
    const user = await findUserByAccessToken(accessToken);
    if (user) {
      return { user, method: "session" };
    }
  }

  const refreshToken = cookies?.[REFRESH_TOKEN_COOKIE];
  if (!refreshToken) {
    return null;
  }

  try {
    const tokens = await authService.refreshTokens(refreshToken);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    const user = await findUserByAccessToken(tokens.accessToken);
    if (!user) {
      return null;
    }
    return { user, method: "session" };
  } catch {
    return null;
  }
}
