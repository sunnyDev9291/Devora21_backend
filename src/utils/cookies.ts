import { CookieOptions, Response } from "express";
import { env, isSecureCookies } from "../config/env";
import { getAccessTokenMaxAgeMs, getRefreshTokenMaxAgeMs } from "../lib/jwt";

const ACCESS_TOKEN_COOKIE = "access_token";
const REFRESH_TOKEN_COOKIE = "refresh_token";

function getCookieOptions(maxAgeMs: number): CookieOptions {
  const options: CookieOptions = {
    httpOnly: true,
    secure: isSecureCookies,
    sameSite: isSecureCookies ? "none" : "lax",
    maxAge: maxAgeMs,
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
  refreshToken: string
): void {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, getCookieOptions(getAccessTokenMaxAgeMs()));
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, getCookieOptions(getRefreshTokenMaxAgeMs()));
}
export function clearAuthCookies(res: Response): void {
  const clearOptions: CookieOptions = {
    httpOnly: true,
    secure: isSecureCookies,
    sameSite: isSecureCookies ? "none" : "lax",
    path: "/",
  };

  if (env.COOKIE_DOMAIN) {
    clearOptions.domain = env.COOKIE_DOMAIN;
  }

  res.clearCookie(ACCESS_TOKEN_COOKIE, clearOptions);
  res.clearCookie(REFRESH_TOKEN_COOKIE, clearOptions);
}

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE };
