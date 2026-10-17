import { z } from "zod";

const bfsNearbyElementSchema = z.object({
  distance: z.number().int().min(0).max(100).optional(),
  relationship: z.string().max(32).optional(),
  tagName: z.string().max(64).optional(),
  outerHTML: z.string().max(20_000).optional(),
  textPreview: z.string().max(500).optional(),
});

const domContextSchema = z
  .object({
    version: z.number().optional(),
    strategy: z.string().max(32).optional(),
    triggeredOuterHTML: z.string().max(20_000).optional(),
    nearbyElements: z.array(bfsNearbyElementSchema).max(8).optional(),
    pageTitle: z.string().max(500).optional(),
    valuePreview: z.string().max(500).optional(),
    actionType: z.string().max(64).optional(),
    componentType: z.string().max(64).optional(),
    element: z
      .object({
        tagName: z.string().max(64).optional(),
        inputType: z.string().max(64).optional(),
        id: z.string().max(256).optional(),
        name: z.string().max(256).optional(),
        cssSelector: z.string().max(2000).optional(),
        componentType: z.string().max(64).optional(),
      })
      .optional(),
    // Legacy fields (pre-BFS clients)
    labels: z.array(z.string().max(500)).max(12).optional(),
    ariaLabel: z.string().max(500).optional(),
    ariaLabelledBy: z.string().max(1000).optional(),
    ariaDescribedBy: z.string().max(1000).optional(),
    nearbyText: z.string().max(2000).optional(),
    siblings: z
      .array(
        z.object({
          tag: z.string().max(64).optional(),
          text: z.string().max(500).optional(),
        })
      )
      .max(12)
      .optional(),
    parents: z
      .array(
        z.object({
          tag: z.string().max(64).optional(),
          id: z.string().max(256).optional(),
          className: z.string().max(500).optional(),
          text: z.string().max(800).optional(),
        })
      )
      .max(4)
      .optional(),
    htmlSnippet: z.string().max(20_000).optional(),
  })
  .optional();

/** Chronological DOM input event (+ optional context for DeepSeek Q match). */
const inputEventSchema = z.object({
  elementKey: z.string().trim().min(1).max(500),
  value: z.string().max(20_000),
  eventType: z.string().trim().max(64).optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  tagName: z.string().trim().max(64).optional(),
  inputType: z.string().trim().max(64).optional(),
  elementId: z.string().trim().max(256).optional(),
  name: z.string().trim().max(256).optional(),
  className: z.string().trim().max(1000).optional(),
  cssSelector: z.string().trim().max(2000).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  label: z.string().trim().max(2000).optional(),
  autocomplete: z.string().trim().max(128).optional(),
  actionType: z.string().trim().max(64).optional(),
  componentType: z.string().trim().max(64).optional(),
  triggeredOuterHTML: z.string().max(20_000).optional(),
  /** Client-side cached AI question — skips DeepSeek when set. */
  cachedQuestion: z.string().trim().max(2000).optional(),
  cachedConfidence: z.number().min(0).max(1).optional(),
  /** BFS DOM context for first-time matching. */
  domContext: domContextSchema,
  /** When true, request AI match even if a prior unmatched row exists. */
  forceMatch: z.boolean().optional(),
});

const legacyQaPairSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  answer: z.string().max(20_000),
  fieldType: z.string().trim().max(64).optional(),
  fieldName: z.string().trim().max(256).optional(),
  autocomplete: z.string().trim().max(128).optional(),
  elementKey: z.string().trim().max(500).optional(),
  eventType: z.string().trim().max(64).optional(),
  cssSelector: z.string().trim().max(2000).optional(),
  tagName: z.string().trim().max(64).optional(),
  elementId: z.string().trim().max(256).optional(),
  className: z.string().trim().max(1000).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
  cachedQuestion: z.string().trim().max(2000).optional(),
  domContext: domContextSchema,
});

export const syncApplicationQaSchema = z
  .object({
    user_id: z.string().trim().optional(),
    userId: z.string().trim().optional(),
    tab_url: z.string().trim().url().optional(),
    tabUrl: z.string().trim().url().optional(),
    tab_session_id: z.string().trim().min(8).max(128).optional(),
    tabSessionId: z.string().trim().min(8).max(128).optional(),
    page_title: z.string().trim().max(500).optional(),
    pageTitle: z.string().trim().max(500).optional(),
    status: z.enum(["recording", "paused"]).optional(),
    input_events: z.array(inputEventSchema).optional(),
    inputEvents: z.array(inputEventSchema).optional(),
    questions_answers: z.array(legacyQaPairSchema).optional(),
    questionsAnswers: z.array(legacyQaPairSchema).optional(),
  })
  .transform((v) => {
    const tabUrl = (v.tabUrl || v.tab_url || "").trim();
    const tabSessionId = (v.tabSessionId || v.tab_session_id || "").trim();

    const fromEvents = (v.inputEvents ?? v.input_events ?? []).map((e) => ({
      elementKey: e.elementKey,
      value: e.value ?? "",
      eventType: e.eventType,
      timestamp: e.timestamp,
      tagName: e.tagName,
      inputType: e.inputType,
      elementId: e.elementId,
      name: e.name,
      className: e.className,
      cssSelector: e.cssSelector,
      attributes: e.attributes,
      label: e.label,
      autocomplete: e.autocomplete,
      actionType: e.actionType,
      componentType: e.componentType,
      triggeredOuterHTML: e.triggeredOuterHTML,
      cachedQuestion: e.cachedQuestion,
      cachedConfidence: e.cachedConfidence,
      domContext: e.domContext,
      forceMatch: e.forceMatch,
    }));

    const fromLegacy = (v.questionsAnswers ?? v.questions_answers ?? []).map(
      (p) => ({
        elementKey: p.elementKey || p.question,
        value: p.answer ?? "",
        eventType: p.eventType,
        timestamp: p.timestamp,
        tagName: p.tagName,
        inputType: p.fieldType,
        elementId: p.elementId,
        name: p.fieldName,
        className: p.className,
        cssSelector: p.cssSelector,
        attributes: p.attributes,
        label: p.question,
        autocomplete: p.autocomplete,
        cachedQuestion: p.cachedQuestion,
        cachedConfidence: undefined as number | undefined,
        domContext: p.domContext,
        forceMatch: undefined as boolean | undefined,
      })
    );

    return {
      tabUrl,
      tabSessionId,
      pageTitle: (v.pageTitle || v.page_title || "").trim() || undefined,
      status: v.status,
      inputEvents: fromEvents.length ? fromEvents : fromLegacy,
    };
  })
  .superRefine((v, ctx) => {
    if (!v.tabUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tab_url is required",
        path: ["tab_url"],
      });
    }
    if (!v.tabSessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tab_session_id is required",
        path: ["tab_session_id"],
      });
    }
  });

export type SyncApplicationQaInput = z.infer<typeof syncApplicationQaSchema>;

export const patchApplicationQaSessionSchema = z.object({
  status: z.enum(["recording", "paused"]),
});

export type PatchApplicationQaSessionInput = z.infer<
  typeof patchApplicationQaSessionSchema
>;
