import { AuthProvider } from "@prisma/client";
import { emailVerificationRequired } from "../config/env";
import type { SafeUser } from "../services/auth.service";
import type { ListingUrls } from "../lib/listing-urls";

export interface FrontendUser {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  name: string;
  avatar?: string;
  emailVerified: boolean;
  resumeBuilderEnabled: boolean;
  onboardingCompleted: boolean;
  provider: "google" | "local" | "email";
  createdAt?: string;
  resumeTemplateFileName?: string | null;
  promptFileName?: string | null;
  listingUrls?: ListingUrls;
}

function buildDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  email: string
): string {
  const parts = [firstName, lastName].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return email.split("@")[0] ?? email;
}

function mapProvider(provider: AuthProvider): FrontendUser["provider"] {
  if (provider === AuthProvider.GOOGLE) {
    return "google";
  }
  return "local";
}

export function formatUserResponse(user: SafeUser): FrontendUser {
  const formatted: FrontendUser = {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    name: buildDisplayName(user.firstName, user.lastName, user.email),
    emailVerified: emailVerificationRequired ? user.emailVerified : true,
    resumeBuilderEnabled: user.resumeBuilderEnabled,
    onboardingCompleted: user.onboardingCompleted,
    provider: mapProvider(user.provider),
    createdAt: user.createdAt.toISOString(),
  };

  if (user.avatarUrl) {
    formatted.avatar = user.avatarUrl;
  }

  if (user.resumeTemplateFileName) {
    formatted.resumeTemplateFileName = user.resumeTemplateFileName;
  }

  if (user.promptFileName) {
    formatted.promptFileName = user.promptFileName;
  }

  if (user.listingUrls && Object.keys(user.listingUrls).length > 0) {
    formatted.listingUrls = user.listingUrls;
  }

  return formatted;
}
