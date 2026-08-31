import { prisma } from "../lib/prisma";
import { AppError } from "../middleware/errorHandler";
import { toSafeUser, type SafeUser } from "./auth.service";
import {
  resolveCustomPromptText,
  saveAvatarFile,
  savePromptFile,
  saveResumeTemplateFile,
} from "./profile-assets.service";
import { readUserFile } from "./profile-storage.service";
import { avatarContentType } from "../constants/profile-assets";

export interface ProfileMultipartInput {
  firstName?: string;
  lastName?: string;
  customPrompt?: string;
  onboardingCompleted?: boolean;
  files: {
    avatar?: Express.Multer.File;
    resumeTemplate?: Express.Multer.File;
    promptFile?: Express.Multer.File;
  };
}

function fieldError(field: string, message: string): AppError {
  return new AppError(422, message, { [field]: [message] });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw fieldError(field, `${field} is required`);
  }
  return value.trim();
}

export function parseOnboardingMultipart(body: Record<string, unknown>): Omit<
  ProfileMultipartInput,
  "files"
> {
  const firstName = requireString(body.firstName, "firstName");
  const lastName = requireString(body.lastName, "lastName");

  if (body.onboardingCompleted !== "true" && body.onboardingCompleted !== true) {
    throw fieldError("onboardingCompleted", "onboardingCompleted must be true");
  }

  return {
    firstName,
    lastName,
    customPrompt: typeof body.customPrompt === "string" ? body.customPrompt : undefined,
    onboardingCompleted: true,
  };
}

export function parseProfileMultipart(body: Record<string, unknown>): Omit<
  ProfileMultipartInput,
  "files"
> {
  const input: Omit<ProfileMultipartInput, "files"> = {};

  if (body.firstName !== undefined) {
    input.firstName = requireString(body.firstName, "firstName");
  }

  if (body.lastName !== undefined) {
    input.lastName = requireString(body.lastName, "lastName");
  }

  if (typeof body.customPrompt === "string") {
    input.customPrompt = body.customPrompt;
  }

  if (body.onboardingCompleted === "true" || body.onboardingCompleted === true) {
    input.onboardingCompleted = true;
  }

  return input;
}

async function applyProfileFiles(
  userId: string,
  existing: {
    avatarStorageKey: string | null;
    resumeTemplateKey: string | null;
    promptFileKey: string | null;
  },
  input: ProfileMultipartInput
): Promise<{
  avatarStorageKey?: string | null;
  avatarUrl?: string | null;
  resumeTemplateKey?: string;
  resumeTemplateFileName?: string;
  promptFileKey?: string;
  promptFileName?: string;
  customPrompt?: string | null;
}> {
  const updates: {
    avatarStorageKey?: string | null;
    avatarUrl?: string | null;
    resumeTemplateKey?: string;
    resumeTemplateFileName?: string;
    promptFileKey?: string;
    promptFileName?: string;
    customPrompt?: string | null;
  } = {};

  if (input.files.avatar) {
    const avatar = await saveAvatarFile(userId, input.files.avatar, existing.avatarStorageKey);
    updates.avatarStorageKey = avatar.avatarStorageKey;
    updates.avatarUrl = avatar.avatarUrl;
  }

  if (input.files.resumeTemplate) {
    const resume = await saveResumeTemplateFile(
      userId,
      input.files.resumeTemplate,
      existing.resumeTemplateKey
    );
    updates.resumeTemplateKey = resume.resumeTemplateKey;
    updates.resumeTemplateFileName = resume.resumeTemplateFileName;
  }

  let parsedPromptFromFile: string | undefined;
  if (input.files.promptFile) {
    const prompt = await savePromptFile(
      userId,
      input.files.promptFile,
      existing.promptFileKey
    );
    updates.promptFileKey = prompt.promptFileKey;
    updates.promptFileName = prompt.promptFileName;
    parsedPromptFromFile = prompt.customPrompt;
  }

  const customPrompt = resolveCustomPromptText(parsedPromptFromFile, input.customPrompt);
  if (customPrompt !== undefined) {
    updates.customPrompt = customPrompt;
  }

  return updates;
}

export async function completeOnboarding(
  userId: string,
  input: ProfileMultipartInput
): Promise<SafeUser> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    throw new AppError(404, "User not found");
  }

  const fileUpdates = await applyProfileFiles(
    userId,
    {
      avatarStorageKey: existing.avatarStorageKey,
      resumeTemplateKey: existing.resumeTemplateKey,
      promptFileKey: existing.promptFileKey,
    },
    input
  );

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      firstName: input.firstName!.trim(),
      lastName: input.lastName!.trim(),
      onboardingCompleted: true,
      ...fileUpdates,
    },
  });

  return toSafeUser(user);
}

export async function updateUserProfile(
  userId: string,
  input: ProfileMultipartInput
): Promise<SafeUser> {
  const existing = await prisma.user.findUnique({ where: { id: userId } });
  if (!existing) {
    throw new AppError(404, "User not found");
  }

  const hasTextUpdate =
    input.firstName !== undefined ||
    input.lastName !== undefined ||
    input.customPrompt !== undefined ||
    input.onboardingCompleted === true;

  const hasFileUpdate =
    Boolean(input.files.avatar) ||
    Boolean(input.files.resumeTemplate) ||
    Boolean(input.files.promptFile);

  if (!hasTextUpdate && !hasFileUpdate) {
    throw new AppError(422, "At least one profile field is required", {
      profile: ["At least one profile field is required"],
    });
  }

  const fileUpdates = await applyProfileFiles(
    userId,
    {
      avatarStorageKey: existing.avatarStorageKey,
      resumeTemplateKey: existing.resumeTemplateKey,
      promptFileKey: existing.promptFileKey,
    },
    input
  );

  const shouldCompleteOnboarding =
    input.onboardingCompleted === true && !existing.onboardingCompleted;

  const user = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.firstName !== undefined ? { firstName: input.firstName.trim() } : {}),
      ...(input.lastName !== undefined ? { lastName: input.lastName.trim() } : {}),
      ...fileUpdates,
      ...(shouldCompleteOnboarding ? { onboardingCompleted: true } : {}),
    },
  });

  return toSafeUser(user);
}

export async function getUserPrompt(userId: string): Promise<{
  content: string;
  fileName: string;
}> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.customPrompt) {
    throw new AppError(404, "Prompt not found");
  }

  return {
    content: user.customPrompt,
    fileName: user.promptFileName ?? "prompt.txt",
  };
}

export async function getUserResumeTemplate(userId: string): Promise<{
  fileName: string;
  templateBase64: string;
}> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.resumeTemplateKey || !user.resumeTemplateFileName) {
    throw new AppError(404, "Resume template not found");
  }

  const buffer = await readUserFile(user.resumeTemplateKey);

  return {
    fileName: user.resumeTemplateFileName,
    templateBase64: buffer.toString("base64"),
  };
}

export async function getUserAvatar(userId: string): Promise<{
  buffer: Buffer;
  contentType: string;
}> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.avatarStorageKey) {
    throw new AppError(404, "Avatar not found");
  }

  const buffer = await readUserFile(user.avatarStorageKey);

  return {
    buffer,
    contentType: avatarContentType(user.avatarStorageKey),
  };
}
