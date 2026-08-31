import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { ALLOWED_FRONTEND_ORIGINS } from "../config/frontend";

export { ALLOWED_FRONTEND_ORIGINS };
export type OAuthIntent = "signup" | "login";

export interface OAuthFlowState {
  intent: OAuthIntent;
  complete_url: string;
  signup_success_url?: string;
  signup_exists_url?: string;
  login_success_url?: string;
  login_fallback_url?: string;
  prompt?: string;
}

interface SignedOAuthFlowState extends OAuthFlowState {
  exp: number;
}

const STATE_TTL_SECONDS = 10 * 60;

export function isAllowedRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_FRONTEND_ORIGINS.includes(parsed.origin);
  } catch {
    return false;
  }
}

function requireAllowedUrl(url: string, fieldName: string): string {
  if (!isAllowedRedirectUrl(url)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return url;
}

export function parseOAuthStartQuery(query: Record<string, unknown>): OAuthFlowState {
  const intent = query.intent;
  if (intent !== "signup" && intent !== "login") {
    throw new Error("Invalid intent");
  }

  const completeUrl = typeof query.complete_url === "string" ? query.complete_url : "";
  if (!completeUrl) {
    throw new Error("complete_url is required");
  }

  const state: OAuthFlowState = {
    intent,
    complete_url: requireAllowedUrl(completeUrl, "complete_url"),
  };

  if (intent === "signup") {
    const signupSuccessUrl =
      typeof query.signup_success_url === "string" ? query.signup_success_url : "";
    const signupExistsUrl =
      typeof query.signup_exists_url === "string" ? query.signup_exists_url : "";

    if (signupSuccessUrl) {
      state.signup_success_url = requireAllowedUrl(signupSuccessUrl, "signup_success_url");
    }
    if (signupExistsUrl) {
      state.signup_exists_url = requireAllowedUrl(signupExistsUrl, "signup_exists_url");
    }
  }

  if (intent === "login") {
    const loginSuccessUrl =
      typeof query.login_success_url === "string" ? query.login_success_url : "";
    const loginFallbackUrl =
      typeof query.login_fallback_url === "string" ? query.login_fallback_url : "";

    if (loginSuccessUrl) {
      state.login_success_url = requireAllowedUrl(loginSuccessUrl, "login_success_url");
    }
    if (loginFallbackUrl) {
      state.login_fallback_url = requireAllowedUrl(loginFallbackUrl, "login_fallback_url");
    }
  }

  const prompt = typeof query.prompt === "string" ? query.prompt : undefined;
  if (prompt) {
    state.prompt = prompt;
  }

  return state;
}

export function signOAuthState(state: OAuthFlowState): string {
  const payload: SignedOAuthFlowState = {
    ...state,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
  };

  return jwt.sign(payload, env.JWT_ACCESS_SECRET);
}

export function verifyOAuthState(token: string | undefined): OAuthFlowState {
  if (!token) {
    throw new Error("Missing OAuth state");
  }

  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as SignedOAuthFlowState;

  return {
    intent: decoded.intent,
    complete_url: decoded.complete_url,
    signup_success_url: decoded.signup_success_url,
    signup_exists_url: decoded.signup_exists_url,
    login_success_url: decoded.login_success_url,
    login_fallback_url: decoded.login_fallback_url,
    prompt: decoded.prompt,
  };
}

export function buildOAuthRedirect(
  baseUrl: string,
  result: string,
  extraParams?: Record<string, string>
): string {
  const url = new URL(baseUrl);
  url.searchParams.set("result", result);

  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}
