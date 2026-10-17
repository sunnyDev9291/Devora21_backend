import { env, aiMockEnabled, deepseekEnabled } from "../config/env";
import { logger } from "../lib/logger";

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-pro";
const DEEPSEEK_TIMEOUT_MS = 45_000;
/** Minimum confidence to accept an AI-identified question. */
export const QA_MATCH_MIN_CONFIDENCE = 0.55;

export type BfsNearbyElement = {
  distance?: number;
  relationship?: string;
  tagName?: string;
  outerHTML?: string;
  textPreview?: string;
};

/** BFS-based DOM context (v2) + legacy fields kept optional for older clients. */
export type DomMatchContext = {
  version?: number;
  strategy?: string;
  triggeredOuterHTML?: string;
  nearbyElements?: BfsNearbyElement[];
  pageTitle?: string;
  valuePreview?: string;
  actionType?: string;
  componentType?: string;
  element?: {
    tagName?: string;
    inputType?: string;
    id?: string;
    name?: string;
    cssSelector?: string;
    componentType?: string;
  };
  // Legacy (pre-BFS) — ignored by prompt when nearbyElements present
  labels?: string[];
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  nearbyText?: string;
  siblings?: Array<{ tag?: string; text?: string }>;
  parents?: Array<{
    tag?: string;
    id?: string;
    className?: string;
    text?: string;
  }>;
  htmlSnippet?: string;
};

export type QaMatchResult = {
  matched: boolean;
  question: string;
  answer?: string;
  actionType?: string;
  componentType?: string;
  elementId?: string;
  confidence: number;
  reason?: string;
};

const SYSTEM_PROMPT = `You match a job-application form control to its human-visible QUESTION.

You receive:
- actionType / componentType / current value
- triggered element's original outerHTML
- up to 5 nearby text-bearing DOM elements (original outerHTML + BFS distance/relationship)

Return ONLY a JSON object:
{
  "matched": boolean,
  "question": string,
  "answer": string,
  "actionType": string,
  "componentType": string,
  "elementId": string,
  "confidence": number,
  "reason": string
}

Rules:
- "question" is the recruiter-facing application question for THIS control (e.g. "Full name", "What is your level of English proficiency?").
- "answer" is the user's current value/selection (use the provided value when present).
- For radio/checkbox/Yes-No groups, return the GROUP question, never the option text alone (not "Yes", "Basic", "JavaScript / TypeScript").
- Prefer nearbyElements with smaller distance; read their original HTML for labels/legends/titles.
- Distinguish real answers from navigation/submit (Submit Application, Next, Cancel) → matched=false.
- Do NOT invent a question. If unsure, matched=false, question="", confidence<=0.4.
- confidence is 0..1.
- Do not include markdown fences or extra keys.`;

function stripFences(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(
    /^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/
  );
  if (fenced?.[1]) {
    text = fenced[1].trim();
  } else if (text.startsWith("```")) {
    text = text
      .replace(/^```(?:json|JSON)?\s*\r?\n?/, "")
      .replace(/\r?\n?```\s*$/, "")
      .trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  return text;
}

function clampConfidence(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function heuristicFromBfs(ctx: DomMatchContext): QaMatchResult | null {
  const nearby = ctx.nearbyElements || [];
  for (const n of nearby) {
    const html = String(n.outerHTML || "");
    const titleMatch = html.match(
      /ashby-application-form-question-title[^>]*>([^<]{2,400})/i
    );
    if (titleMatch?.[1]) {
      const q = titleMatch[1].replace(/\s+/g, " ").trim();
      if (q && !/^(yes|no)$/i.test(q)) {
        return {
          matched: true,
          question: q.slice(0, 500),
          answer: String(ctx.valuePreview || ""),
          confidence: 0.78,
          reason: "bfs_title_heuristic",
        };
      }
    }
    const labelMatch = html.match(/<label[^>]*>([^<]{3,400})<\/label>/i);
    if (labelMatch?.[1]) {
      const q = labelMatch[1].replace(/\s+/g, " ").trim();
      if (
        q &&
        q.length > 8 &&
        !/^(yes|no|basic|fluent)/i.test(q)
      ) {
        return {
          matched: true,
          question: q.slice(0, 500),
          answer: String(ctx.valuePreview || ""),
          confidence: 0.7,
          reason: "bfs_label_heuristic",
        };
      }
    }
  }
  // Legacy label fallback
  if (ctx.labels?.[0]?.trim()) {
    const q = ctx.labels[0].replace(/\s+/g, " ").trim().slice(0, 500);
    if (!/^(yes|no)$/i.test(q)) {
      return {
        matched: true,
        question: q,
        answer: String(ctx.valuePreview || ""),
        confidence: 0.75,
        reason: "legacy_label",
      };
    }
  }
  return null;
}

function parseMatch(content: string, fallbackValue: string): QaMatchResult {
  const parsed = JSON.parse(stripFences(content)) as Record<string, unknown>;
  const question = String(parsed.question || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const confidence = clampConfidence(parsed.confidence);
  const matchedFlag = Boolean(parsed.matched) && question.length > 0;
  const matched =
    matchedFlag && confidence >= QA_MATCH_MIN_CONFIDENCE && question.length >= 2;
  return {
    matched,
    question: matched ? question : "",
    answer: String(parsed.answer ?? fallbackValue ?? "").slice(0, 2000),
    actionType: String(parsed.actionType || "").slice(0, 64) || undefined,
    componentType: String(parsed.componentType || "").slice(0, 64) || undefined,
    elementId: String(parsed.elementId || "").slice(0, 256) || undefined,
    confidence,
    reason: String(parsed.reason || "").slice(0, 200) || undefined,
  };
}

function buildPayload(ctx: DomMatchContext) {
  const nearby = (ctx.nearbyElements || []).slice(0, 5).map((n) => ({
    distance: n.distance ?? 0,
    relationship: n.relationship || "",
    tagName: n.tagName || "",
    textPreview: String(n.textPreview || "").slice(0, 240),
    outerHTML: String(n.outerHTML || "").slice(0, 12_000),
  }));

  return {
    actionType: ctx.actionType || "",
    componentType:
      ctx.componentType || ctx.element?.componentType || ctx.element?.inputType || "",
    value: String(ctx.valuePreview || "").slice(0, 500),
    pageTitle: ctx.pageTitle || "",
    triggeredOuterHTML: String(ctx.triggeredOuterHTML || "").slice(0, 12_000),
    element: ctx.element || {},
    nearbyElements: nearby,
    // Legacy fallback only when BFS missing
    ...(nearby.length
      ? {}
      : {
          labels: (ctx.labels || []).slice(0, 8),
          nearbyText: String(ctx.nearbyText || "").slice(0, 800),
          htmlSnippet: String(ctx.htmlSnippet || "").slice(0, 12_000),
        }),
  };
}

/**
 * Identify the application question for a form control via DeepSeek (BFS context).
 */
export async function matchApplicationQuestionWithDeepSeek(
  ctx: DomMatchContext
): Promise<QaMatchResult> {
  const heuristic = heuristicFromBfs(ctx);
  const fallbackValue = String(ctx.valuePreview || "");

  if (aiMockEnabled) {
    return (
      heuristic || {
        matched: false,
        question: "",
        answer: fallbackValue,
        confidence: 0,
        reason: "ai_mock_no_heuristic",
      }
    );
  }

  if (!deepseekEnabled || !env.DEEPSEEK_API_KEY) {
    return (
      heuristic || {
        matched: false,
        question: "",
        answer: fallbackValue,
        confidence: 0,
        reason: "deepseek_not_configured",
      }
    );
  }

  const payload = buildPayload(ctx);

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Match this form action to its application question.\n${JSON.stringify(payload)}`,
          },
        ],
        max_tokens: 512,
        response_format: { type: "json_object" },
        thinking: { type: "disabled" },
      }),
      signal: AbortSignal.timeout(DEEPSEEK_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      logger.warn("application-qa", "DeepSeek match HTTP error", {
        status: response.status,
        body: text.slice(0, 200),
      });
      return (
        heuristic || {
          matched: false,
          question: "",
          answer: fallbackValue,
          confidence: 0,
          reason: `deepseek_http_${response.status}`,
        }
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return (
        heuristic || {
          matched: false,
          question: "",
          answer: fallbackValue,
          confidence: 0,
          reason: "deepseek_empty",
        }
      );
    }

    const ai = parseMatch(content, fallbackValue);
    if (ai.matched) return ai;
    if (heuristic && heuristic.confidence >= QA_MATCH_MIN_CONFIDENCE) {
      return heuristic;
    }
    return ai;
  } catch (err) {
    logger.warn("application-qa", "DeepSeek match failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return (
      heuristic || {
        matched: false,
        question: "",
        answer: fallbackValue,
        confidence: 0,
        reason: "deepseek_error",
      }
    );
  }
}
