import { CookieOptions, Response } from "express";
import { env, isSecureCookies } from "../config/env";
import { getAccessTokenMaxAgeMs, getRefreshTokenMaxAgeMs } from "../lib/jwt";

const ACCESS_TOKEN_COOKIE = "access_token";
const REFRESH_TOKEN_COOKIE = "refresh_token";

function getCookieOptions(maxAgeMs: number): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: isSecureCookies,
    // Required for Netlify (cross-site) → api.devora21.com credentialed calls.
    // Do NOT set Partitioned: OAuth sets cookies on a top-level API redirect;
    // Partitioned cookies from that context are invisible to later Netlify→API fetches.
    sameSite: isSecureCookies ? "none" : "lax",
    maxAge: maxAgeMs,
    path: "/",
  };

  // Optional host/parent domain (e.g. .devora21.com). Leave unset for host-only
  // cookies on api.devora21.com — correct for Netlify → API cross-site auth.
  if (env.COOKIE_DOMAIN) {
    options.domain = env.COOKIE_DOMAIN;
  }

  return options;
}

function getClearCookieOptions(): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: isSecureCookies,
    sameSite: isSecureCookies ? "none" : "lax",
    path: "/",
  };

  if (env.COOKIE_DOMAIN) {
    options.domain = env.COOKIE_DOMAIN;
  }

  return options;
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
  rememberMe = false
): void {
  res.cookie(
    ACCESS_TOKEN_COOKIE,
    accessToken,
    getCookieOptions(getAccessTokenMaxAgeMs())
  );
  res.cookie(
    REFRESH_TOKEN_COOKIE,
    refreshToken,
    getCookieOptions(getRefreshTokenMaxAgeMs(rememberMe))
  );
}

export function clearAuthCookies(res: Response): void {
  const clearOptions = getClearCookieOptions();
  // Clear both partitioned (legacy from prior deploy) and normal cookies.
  res.clearCookie(ACCESS_TOKEN_COOKIE, clearOptions);
  res.clearCookie(REFRESH_TOKEN_COOKIE, clearOptions);
  res.clearCookie(ACCESS_TOKEN_COOKIE, {
    ...clearOptions,
    ...( { partitioned: true } as CookieOptions ),
  });
  res.clearCookie(REFRESH_TOKEN_COOKIE, {
    ...clearOptions,
    ...( { partitioned: true } as CookieOptions ),
  });
}

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
