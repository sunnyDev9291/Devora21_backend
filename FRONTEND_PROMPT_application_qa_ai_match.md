# Frontend Cursor Prompt — Matched Q&A + Unmatched DOM Events (DeepSeek)

Copy everything below into the frontend agent.

================================================================================
GOAL
================================================================================

Super Admin Application Q&A detail must show **two live sections**:

1. **Matched Q&A** — DeepSeek-identified application questions + user answers  
2. **Unmatched DOM events** — controls the AI could not confidently map (element
   metadata + value; do **not** invent a question)

Update both sections in **real time** via existing SSE
(`FRONTEND_PROMPT_application_qa_realtime.md`). No page refresh.

Preserve: owners list, sessions list, filters, delete, Super Admin auth, no-truncate rules.

================================================================================
BACKEND CONTRACT (shipped)
================================================================================

Session detail / SSE `session.updated` payload includes:

```ts
session: {
  // …existing session fields…
  matchedCount: number;
  unmatchedCount: number;

  /** Preferred for matched Q&A table */
  matchedQa: Array<{
    id: string;
    elementKey: string;
    question: string;       // AI question
    answer: string;
    matchConfidence?: number;
    occurredAt: string;
    updatedAt: string;
  }>;

  /** Preferred for unmatched event table */
  unmatchedEvents: Array<{
    id: string;
    elementKey: string;
    value: string;
    label?: string;           // element summary, NOT a fake question
    elementLabel?: string;
    matchStatus: "unmatched";
    tagName?: string;
    inputType?: string;
    elementId?: string;
    name?: string;
    cssSelector?: string;
    attributes?: Record<string, string>;
    eventType?: string;
    occurredAt: string;
    updatedAt: string;
  }>;

  /** Full list (matched + unmatched) if you need one stream */
  inputEvents: Array<{
    matchStatus: "matched" | "unmatched";
    matchedQuestion?: string;
    question: string;
    answer: string; // same as value
    value: string;
    // …element fields…
  }>;

  // Legacy: questionsAnswers now prefers matched rows when any exist
  questionsAnswers: Array<{ question: string; answer: string; … }>;
}
```

SSE events unchanged: `ready`, `session.created`, `session.updated`, `session.deleted`.
On `session.updated` / `session.created`, replace detail state from `session.matchedQa`
and `session.unmatchedEvents` (or derive by filtering `inputEvents`).

================================================================================
UI
================================================================================

### Session detail

**Section A — Matched questions & answers**
- Table: Question | Answer | Confidence (optional) | Updated
- Sort by `occurredAt` / `updatedAt`
- Empty state: “No matched questions yet — waiting for DeepSeek…”

**Section B — Unmatched DOM events**
- Table: Time | Event | Element (tag/type/#id/[name]/selector) | Value
- Expandable attributes
- Empty state OK when all matched

Header chips: `Matched: N` · `Unmatched: M` · Live indicator from SSE

### Session list
- Keep event count; optionally show `matchedCount` if present

### Do NOT
- Invent questions for unmatched rows
- Hide unmatched (admins need visibility)
- Poll when SSE is live
- Truncate questions/answers/URLs with ellipsis

================================================================================
ACCEPTANCE
================================================================================

1) Typing on an Apply Page → within ~1–2s a matched row appears OR an unmatched
   event appears (never invent).
2) Further typing on the **same** field updates **answer only** (no duplicate
   questions; no extra spinner storm).
3) SSE updates list/detail without refresh.
4) Radio groups show one question with selected YES/NO answer when matched.
5) Non–super-admin still blocked (403).

================================================================================
NOTES
================================================================================

- Matching runs on the **backend** with DeepSeek; frontend only renders results.
- Extension still detects Apply Page (email + resume) before syncing.
- If `matchedQa` is missing (old payload), fall back to
  `inputEvents.filter(e => e.matchStatus === "matched")`.
