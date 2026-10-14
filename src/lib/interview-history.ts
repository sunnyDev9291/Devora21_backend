import { Prisma } from "@prisma/client";

export type InterviewRoundRecord = {
  round: number;
  downloadedAt: string;
};

export type InterviewHistoryView = {
  interviewHistory: InterviewRoundRecord[];
  nextInterviewRound: number;
};

/** Parse stored JSON into sorted unique round records. */
export function parseInterviewHistory(raw: unknown): InterviewRoundRecord[] {
  if (!Array.isArray(raw)) return [];

  const byRound = new Map<number, InterviewRoundRecord>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const round = Number(row.round);
    if (!Number.isInteger(round) || round < 1) continue;

    const downloadedAtRaw =
      typeof row.downloadedAt === "string"
        ? row.downloadedAt
        : typeof row.date === "string"
          ? row.date
          : typeof row.downloaded_at === "string"
            ? row.downloaded_at
            : null;
    if (!downloadedAtRaw) continue;
    const at = new Date(downloadedAtRaw);
    if (Number.isNaN(at.getTime())) continue;

    // Keep earliest date if duplicate round numbers appear.
    const iso = at.toISOString();
    const existing = byRound.get(round);
    if (!existing || iso < existing.downloadedAt) {
      byRound.set(round, { round, downloadedAt: iso });
    }
  }

  return [...byRound.values()].sort((a, b) => a.round - b.round);
}

export function nextInterviewRound(
  history: InterviewRoundRecord[]
): number {
  if (history.length === 0) return 1;
  return Math.max(...history.map((r) => r.round)) + 1;
}

export function interviewHistoryView(raw: unknown): InterviewHistoryView {
  const interviewHistory = parseInterviewHistory(raw);
  return {
    interviewHistory,
    nextInterviewRound: nextInterviewRound(interviewHistory),
  };
}

export function interviewHistoryDbValue(
  history: InterviewRoundRecord[]
): Prisma.InputJsonValue {
  return history.map((r) => ({
    round: r.round,
    downloadedAt: r.downloadedAt,
  })) as Prisma.InputJsonValue;
}

/** Human-readable label helper for docs/FE examples: "Round 1: Oct 14, 2026". */
export function formatInterviewRoundLabel(
  record: InterviewRoundRecord,
  timeZone = "UTC"
): string {
  const d = new Date(record.downloadedAt);
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(d);
  return `Round ${record.round}: ${formatted}`;
}
