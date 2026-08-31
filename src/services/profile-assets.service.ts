import { AppError } from "../middleware/errorHandler";
import { sanitizePlainText } from "../utils/text";
import {
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  CUSTOM_PROMPT_MAX_CHARS,
  PROMPT_MAX_BYTES,
  PROMPT_MIME_TYPES,
  RESUME_TEMPLATE_MIME,
  avatarExtension,
  buildProfileAvatarUrl,
  promptExtension,
} from "../constants/profile-assets";
import { replaceUserFile } from "./profile-storage.service";
import { env } from "../config/env";

function fieldError(field: string, message: string): AppError {
  return new AppError(422, message, { [field]: [message] });
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/[/\\<>:"|?*\x00-\x1f]/g, "_").trim();
  return base.slice(0, 200) || "file";
}

function truncatePrompt(text: string): string {
  const sanitized = sanitizePlainText(text);
  if (sanitized.length > CUSTOM_PROMPT_MAX_CHARS) {
    return sanitized.slice(0, CUSTOM_PROMPT_MAX_CHARS);
  }
  return sanitized;
}

export function parsePromptFileContent(
  buffer: Buffer,
  mimeType: string,
  originalName: string
): string {
  const lowerName = originalName.toLowerCase();

  if (mimeType === "application/json" || lowerName.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString("utf8"));
    } catch {
      throw fieldError("promptFile", "Invalid JSON prompt file");
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("content" in parsed) ||
      typeof (parsed as { content: unknown }).content !== "string"
    ) {
      throw fieldError("promptFile", 'JSON prompt file must contain { "content": "..." }');
    }

    const content = truncatePrompt((parsed as { content: string }).content);
    if (!content) {
      throw fieldError("promptFile", "Prompt content cannot be empty");
    }
    return content;
  }

  const content = truncatePrompt(buffer.toString("utf8"));
  if (!content) {
    throw fieldError("promptFile", "Prompt file cannot be empty");
  }
  return content;
}

export async function saveAvatarFile(
  userId: string,
  file: Express.Multer.File,
  previousKey: string | null | undefined
): Promise<{ avatarStorageKey: string; avatarUrl: string }> {
  if (!AVATAR_MIME_TYPES.has(file.mimetype)) {
    throw fieldError("avatar", "Avatar must be JPEG, PNG, WebP, or GIF");
  }

  if (file.size > AVATAR_MAX_BYTES) {
    throw fieldError("avatar", "Avatar must be 5 MB or smaller");
  }

  const filename = `avatar.${avatarExtension(file.mimetype)}`;
  const avatarStorageKey = await replaceUserFile(
    userId,
    filename,
    file.buffer,
    previousKey
  );

  return {
    avatarStorageKey,
    avatarUrl: buildProfileAvatarUrl(),
  };
}

export async function saveResumeTemplateFile(
  userId: string,
  file: Express.Multer.File,
  previousKey: string | null | undefined
): Promise<{ resumeTemplateKey: string; resumeTemplateFileName: string }> {
  const isDocxMime = file.mimetype === RESUME_TEMPLATE_MIME;
  const isDocxName = file.originalname.toLowerCase().endsWith(".docx");

  if (!isDocxMime && !isDocxName) {
    throw fieldError("resumeTemplate", "Resume template must be a .docx file");
  }

  if (file.size > env.RESUME_MAX_FILE_SIZE_BYTES) {
    throw fieldError(
      "resumeTemplate",
      `Resume template must be ${env.RESUME_MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB or smaller`
    );
  }

  const resumeTemplateKey = await replaceUserFile(
    userId,
    "resume-template.docx",
    file.buffer,
    previousKey
  );

  return {
    resumeTemplateKey,
    resumeTemplateFileName: sanitizeFilename(file.originalname),
  };
}

export async function savePromptFile(
  userId: string,
  file: Express.Multer.File,
  previousKey: string | null | undefined
): Promise<{
  promptFileKey: string;
  promptFileName: string;
  customPrompt: string;
}> {
  const lowerName = file.originalname.toLowerCase();
  const allowedMime =
    PROMPT_MIME_TYPES.has(file.mimetype) ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json");

  if (!allowedMime) {
    throw fieldError("promptFile", "Prompt file must be .txt, .md, or .json");
  }

  if (file.size > PROMPT_MAX_BYTES) {
    throw fieldError("promptFile", "Prompt file must be 512 KB or smaller");
  }

  const customPrompt = parsePromptFileContent(file.buffer, file.mimetype, file.originalname);
  const ext = promptExtension(file.mimetype, file.originalname);
  const promptFileKey = await replaceUserFile(
    userId,
    `prompt.${ext}`,
    file.buffer,
    previousKey
  );

  return {
    promptFileKey,
    promptFileName: sanitizeFilename(file.originalname),
    customPrompt,
  };
}

export function resolveCustomPromptText(
  filePrompt: string | undefined,
  bodyPrompt: string | undefined
): string | null | undefined {
  if (filePrompt !== undefined) {
    return filePrompt;
  }

  if (bodyPrompt === undefined) {
    return undefined;
  }

  const trimmed = bodyPrompt.trim();
  if (!trimmed) {
    return null;
  }

  return truncatePrompt(trimmed);
}
