import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import { AuthProvider, User } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  getRefreshTokenExpiry,
  getTokenExpiry,
} from "../lib/jwt";
import { AppError } from "../middleware/errorHandler";
import { emailVerificationRequired } from "../config/env";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "./email.service";
import type {
  RegisterInput,
  LoginInput,
  ForgotPasswordInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from "../validators/auth.validator";
import {
  listingUrlsForResponse,
  type ListingUrls,
} from "../lib/listing-urls";

const SALT_ROUNDS = 12;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SafeUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  avatarStorageKey: string | null;
  provider: AuthProvider;
  emailVerified: boolean;
  resumeBuilderEnabled: boolean;
  onboardingCompleted: boolean;
  resumeTemplateKey: string | null;
  resumeTemplateFileName: string | null;
  promptFileKey: string | null;
  promptFileName: string | null;
  customPrompt: string | null;
  listingUrls?: ListingUrls;
  createdAt: Date;
}

export function toSafeUser(user: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  avatarStorageKey?: string | null;
  provider: AuthProvider;
  emailVerified: boolean;
  resumeBuilderEnabled?: boolean;
  onboardingCompleted?: boolean;
  resumeTemplateKey?: string | null;
  resumeTemplateFileName?: string | null;
  promptFileKey?: string | null;
  promptFileName?: string | null;
  customPrompt?: string | null;
  listingUrls?: unknown;
  createdAt: Date;
}): SafeUser {
  const listingUrls = listingUrlsForResponse(user.listingUrls);
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    avatarStorageKey: user.avatarStorageKey ?? null,
    provider: user.provider,
    emailVerified: user.emailVerified,
    resumeBuilderEnabled: user.resumeBuilderEnabled ?? false,
    onboardingCompleted: user.onboardingCompleted ?? false,
    resumeTemplateKey: user.resumeTemplateKey ?? null,
    resumeTemplateFileName: user.resumeTemplateFileName ?? null,
    promptFileKey: user.promptFileKey ?? null,
    promptFileName: user.promptFileName ?? null,
    customPrompt: user.customPrompt ?? null,
    ...(listingUrls ? { listingUrls } : {}),
    createdAt: user.createdAt,
  };
}

async function createTokens(userId: string, email: string): Promise<AuthTokens> {
  const payload = { sub: userId, email };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId,
      expiresAt: getRefreshTokenExpiry(),
    },
  });

  return { accessToken, refreshToken };
}

export async function register(
  input: RegisterInput
): Promise<{ user: SafeUser; tokens: AuthTokens }> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (existing) {
    throw new AppError(409, "Email already exists");
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: {
      email: input.email.toLowerCase(),
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      provider: AuthProvider.LOCAL,
      emailVerified: !emailVerificationRequired,
    },
  });

  if (emailVerificationRequired) {
    const verificationToken = uuidv4();
    await prisma.emailVerificationToken.create({
      data: {
        token: verificationToken,
        userId: user.id,
        expiresAt: getTokenExpiry(24),
      },
    });

    await sendVerificationEmail(user.email, verificationToken);
  }

  const tokens = await createTokens(user.id, user.email);

  return { user: toSafeUser(user), tokens };
}

export async function login(
  input: LoginInput
): Promise<{ user: SafeUser; tokens: AuthTokens }> {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase() },
  });

  if (!user || !user.passwordHash) {
    throw new AppError(401, "Invalid email or password");
  }

  const valid = await bcrypt.compare(input.password, user.passwordHash);
  if (!valid) {
    throw new AppError(401, "Invalid email or password");
  }

  const tokens = await createTokens(user.id, user.email);

  return { user: toSafeUser(user), tokens };
}

export async function logout(
  refreshToken: string | undefined,
  userId?: string
): Promise<void> {
  if (userId) {
    await revokeAllRefreshTokens(userId);
    return;
  }

  if (refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { token: refreshToken, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function refreshTokens(
  refreshToken: string | undefined
): Promise<AuthTokens> {
  if (!refreshToken) {
    throw new AppError(401, "Refresh token required");
  }

  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(401, "Invalid or expired refresh token");
  }

  const stored = await prisma.refreshToken.findUnique({
    where: { token: refreshToken },
  });

  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw new AppError(401, "Invalid or expired refresh token");
  }

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return createTokens(payload.sub, payload.email);
}

export async function getCurrentUser(userId: string): Promise<SafeUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError(404, "User not found");
  }

  return toSafeUser(user);
}

export async function findUserById(userId: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function forgotPassword(input: ForgotPasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email: input.email.toLowerCase() },
  });

  // Always succeed to prevent email enumeration
  if (!user || !user.passwordHash) {
    return;
  }

  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = uuidv4();
  await prisma.passwordResetToken.create({
    data: {
      token,
      userId: user.id,
      expiresAt: getTokenExpiry(1),
    },
  });

  await sendPasswordResetEmail(user.email, token);
}

export async function resetPassword(input: ResetPasswordInput): Promise<void> {
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { token: input.token },
    include: { user: true },
  });

  if (!resetToken || resetToken.usedAt || resetToken.expiresAt < new Date()) {
    throw new AppError(400, "Invalid or expired reset token");
  }

  const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: resetToken.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

export async function verifyEmail(input: VerifyEmailInput): Promise<void> {
  const verificationToken = await prisma.emailVerificationToken.findUnique({
    where: { token: input.token },
    include: { user: true },
  });

  if (
    !verificationToken ||
    verificationToken.usedAt ||
    verificationToken.expiresAt < new Date()
  ) {
    throw new AppError(400, "Invalid or expired verification token");
  }

  await prisma.$transaction([
    prisma.emailVerificationToken.update({
      where: { id: verificationToken.id },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: verificationToken.userId },
      data: { emailVerified: true },
    }),
  ]);
}

export async function resendVerificationEmail(email: string): Promise<void> {
  if (!emailVerificationRequired) {
    return;
  }
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (!user || user.emailVerified || user.provider !== AuthProvider.LOCAL) {
    return;
  }

  await prisma.emailVerificationToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const verificationToken = uuidv4();
  await prisma.emailVerificationToken.create({
    data: {
      token: verificationToken,
      userId: user.id,
      expiresAt: getTokenExpiry(24),
    },
  });

  await sendVerificationEmail(user.email, verificationToken);
}

export interface OAuthProfile {
  provider: AuthProvider;
  providerId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  avatarUrl?: string;
}

export async function createGoogleUser(profile: OAuthProfile): Promise<SafeUser> {
  const email = profile.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new AppError(409, "Email already exists");
  }

  const user = await prisma.user.create({
    data: {
      email,
      provider: AuthProvider.GOOGLE,
      providerId: profile.providerId,
      firstName: profile.firstName,
      lastName: profile.lastName,
      avatarUrl: profile.avatarUrl,
      emailVerified: true,
    },
  });

  return toSafeUser(user);
}

export async function loginGoogleUser(
  profile: OAuthProfile
): Promise<{ user: SafeUser; tokens: AuthTokens }> {
  const email = profile.email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    throw new AppError(404, "No account found");
  }

  const user = await prisma.user.update({
    where: { id: existing.id },
    data: {
      provider: AuthProvider.GOOGLE,
      providerId: profile.providerId,
      emailVerified: true,
      firstName: existing.firstName ?? profile.firstName,
      lastName: existing.lastName ?? profile.lastName,
      avatarUrl: existing.avatarUrl ?? profile.avatarUrl,
    },
  });

  const tokens = await createTokens(user.id, user.email);
  return { user: toSafeUser(user), tokens };
}

