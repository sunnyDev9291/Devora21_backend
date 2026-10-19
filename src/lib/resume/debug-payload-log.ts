import { mkdirSync, writeFileSync } from "fs";
import path from "path";

const LOG_DIR = path.join(process.cwd(), "tmp");
const LOG_FILE = path.join(LOG_DIR, "last-resume-ai-payload.json");

/**
 * Overwrite tmp/last-resume-ai-payload.json with the Claude messages
 * for the latest resume generate (web or one-click).
 */
export function writeLastResumeAiPayloadLog(payload: {
  at: string;
  context: string;
  userId: string;
  jobTitle: string;
  jobDescriptionChars: number;
  templateId: string;
  writingPromptSource: string;
  messages: Array<{ role: string; content: string }>;
}): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(
      LOG_FILE,
      JSON.stringify(
        {
          ...payload,
          messageRoles: payload.messages.map((m) => m.role),
          messageSizes: payload.messages.map((m) => ({
            role: m.role,
            chars: m.content.length,
          })),
          totalChars: payload.messages.reduce((n, m) => n + m.content.length, 0),
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`[resume/generate] wrote AI payload log → ${LOG_FILE}`);
  } catch (err) {
    console.warn(
      `[resume/generate] failed to write AI payload log: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export function lastResumeAiPayloadLogPath(): string {
  return LOG_FILE;
}
