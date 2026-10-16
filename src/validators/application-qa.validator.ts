import { z } from "zod";

/** Chronological DOM input event from the Chrome extension (no Q→A matching). */
const inputEventSchema = z.object({
  /** Stable element identity within the tab session. */
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
  /** Optional display summary; server can derive if missing. */
  label: z.string().trim().max(2000).optional(),
  autocomplete: z.string().trim().max(128).optional(),
});

/** Legacy shape — accepted and mapped into input events. */
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
