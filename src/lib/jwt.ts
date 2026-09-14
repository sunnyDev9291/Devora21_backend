import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { env } from "../config/env";

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export interface RefreshTokenPayload extends AccessTokenPayload {
  jti: string;
  rememberMe: boolean;
}

/** Short-lived access token (sliding via refresh). */
export function getAccessTokenExpiresIn(): string {
  return env.JWT_ACCESS_EXPIRES_IN;
}

/** Session refresh window when rememberMe is false. */
export function getSessionRefreshExpiresIn(): string {
  return env.JWT_REFRESH_EXPIRES_IN;
}

/** Long-lived refresh window when rememberMe is true (30 days). */
export function getRememberRefreshExpiresIn(): string {
  return env.JWT_REFRESH_REMEMBER_EXPIRES_IN;
}

export function getRefreshExpiresIn(rememberMe: boolean): string {
  return rememberMe ? getRememberRefreshExpiresIn() : getSessionRefreshExpiresIn();
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: getAccessTokenExpiresIn() as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(
  payload: AccessTokenPayload & { rememberMe?: boolean }
): string {
  const rememberMe = payload.rememberMe === true;
  return jwt.sign(
    { sub: payload.sub, email: payload.email, jti: uuidv4(), rememberMe },
    env.JWT_REFRESH_SECRET,
    {
      expiresIn: getRefreshExpiresIn(rememberMe) as jwt.SignOptions["expiresIn"],
    }
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
  return {
    sub: payload.sub,
    email: payload.email,
    jti: payload.jti,
    rememberMe: payload.rememberMe === true,
  };
}

export function getRefreshTokenExpiry(rememberMe = false): Date {
  return new Date(
    Date.now() +
      parseDurationMs(
        getRefreshExpiresIn(rememberMe),
        rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
      )
  );
}

export function getAccessTokenMaxAgeMs(): number {
  return parseDurationMs(getAccessTokenExpiresIn(), 15 * 60 * 1000);
}

export function getRefreshTokenMaxAgeMs(rememberMe = false): number {
  return parseDurationMs(
    getRefreshExpiresIn(rememberMe),
    rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
  );
}

function parseDurationMs(duration: string, fallbackMs: number): number {
  const match = duration.match(/^(\d+)([dhms])$/);
  if (!match) {
    return fallbackMs;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000,
  };

  return value * multipliers[unit];
}

export function getTokenExpiry(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}
