import { AppError } from "../../middleware/errorHandler";
import { getUserPrompt } from "../../services/onboarding.service";

export type WritingPromptSource = "request_body" | "profile_store" | "cache";

export type ResolvedWritingPrompt = {
  content: string;
  source: WritingPromptSource;
  fileName?: string;
};

/** Prefer customPrompt, then profilePrompt, then promptContent. */
export function pickRequestWritingPrompt(input: {
  customPrompt?: string | null;
  profilePrompt?: string | null;
  promptContent?: string | null;
}): string | undefined {
  for (const value of [input.customPrompt, input.profilePrompt, input.promptContent]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Resolve writing instructions for resume generation.
 * 1) Non-empty request body fields win
 * 2) Else latest profile store (with optional cache — invalidated on upload)
 */
export async function resolveWritingPrompt(input: {
  userId: string;
  customPrompt?: string | null;
  profilePrompt?: string | null;
  promptContent?: string | null;
  context: string;
}): Promise<ResolvedWritingPrompt> {
  const fromBody = pickRequestWritingPrompt(input);
  if (fromBody) {
    console.log(
      `[prompt] source=request_body context=${input.context} user=${input.userId} chars=${fromBody.length}`
    );
    return { content: fromBody, source: "request_body" };
  }

  try {
    const stored = await getUserPrompt(input.userId);
    const content = stored.content.trim();
    if (!content) {
      throw new AppError(404, "Prompt not found");
    }
    // getUserPrompt logs cache vs profile_store via its return metadata when present
    const source: WritingPromptSource = stored.source ?? "profile_store";
    console.log(
      `[prompt] source=${source} context=${input.context} user=${input.userId} chars=${content.length}`
    );
    return {
      content,
      source,
      fileName: stored.fileName,
    };
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) {
      throw new AppError(
        422,
        "Profile prompt not found. Upload a prompt in your Devora21 profile before generating a resume."
      );
    }
    throw err;
  }
}
