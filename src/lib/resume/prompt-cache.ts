/**
 * In-memory profile-prompt cache (userId → content).
 * Cleared on every successful prompt upload/update so generation never
 * keeps using a stale prompt after PATCH /auth/profile.
 */
type CachedPrompt = {
  content: string;
  fileName: string;
  cachedAt: number;
};

const promptByUserId = new Map<string, CachedPrompt>();

/** Drop cached prompt for a user (or all users if userId omitted). */
export function invalidatePromptCache(userId?: string): void {
  if (!userId) {
    promptByUserId.clear();
    console.log("[prompt] cache_invalidated scope=all");
    return;
  }
  promptByUserId.delete(userId);
  console.log(`[prompt] cache_invalidated user=${userId}`);
}

export function getCachedPrompt(userId: string): CachedPrompt | null {
  return promptByUserId.get(userId) ?? null;
}

export function setCachedPrompt(
  userId: string,
  content: string,
  fileName: string
): void {
  promptByUserId.set(userId, {
    content,
    fileName,
    cachedAt: Date.now(),
  });
}
