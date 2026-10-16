# Frontend Cursor Prompt — Application Q&A → DOM Input Events

Copy everything below into the frontend agent.

================================================================================
BREAKING UI CHANGE (backend already shipped)
================================================================================

Stop showing “Question / Answer” as the primary detail view.

The Chrome extension **no longer tries to match questions to answers**. It records
**DOM input events** on Apply Pages. Super Admin must show a **chronological list
of those events**.

Keep:
- Owners list, sessions list, filters, delete, Super Admin gate
- Live SSE (`FRONTEND_PROMPT_application_qa_realtime.md`)
- Full URL / no ellipsis truncation rules

================================================================================
DATA SHAPE
================================================================================

Session detail (`GET /admin/application-qa/sessions/:id` and SSE `session.updated`):

Prefer:

```ts
session.inputEvents: Array<{
  id: string;
  elementKey: string;
  value: string;
  eventType?: string;      // input | change | click | blur
  tagName?: string;
  inputType?: string;
  elementId?: string;
  name?: string;
  className?: string;
  cssSelector?: string;
  attributes?: Record<string, string>;
  label?: string;          // short element summary, NOT a scraped "question"
  occurredAt: string;      // ISO
  updatedAt: string;
}>
```

Also present for compatibility:
- `input_events` (alias)
- `questionsAnswers` / `questions_answers` (same rows; `question`≈label, `answer`≈value)
- `eventCount` / `itemCount`

Sort by `occurredAt` ascending (chronological). Backend already orders this way.

================================================================================
DETAIL PAGE UI
================================================================================

Replace Q&A table with **DOM Input Events** table/list:

| Time | Event | Element | Value |
|------|-------|---------|-------|
| occurredAt (full locale) | eventType | tag + type + #id / [name] / cssSelector | value (wrap, no truncate) |

Optional expandable row: `attributes` JSON, `className`, `elementKey`.

Header copy:
- “DOM input events” (not “Questions & answers”)
- Show `eventCount`

Live recording: when SSE `session.updated` arrives for the open session, **replace**
the event list from `session.inputEvents` (upsert by `id` / `elementKey`).

List page: column “Items” → **Events** (`eventCount` or `itemCount`).

================================================================================
DO NOT
================================================================================

- Do not invent question text from labels.
- Do not merge YES/NO into prose Q&A.
- Do not poll if SSE is connected.
- Do not ellipsis-truncate URL, selector, or values.

================================================================================
ACCEPTANCE
================================================================================

1) Detail shows chronological DOM events with element metadata + value
2) Typing in extension updates the list live (SSE)
3) Unchanged re-types do not spam duplicate rows (same elementKey upserts)
4) Radio group = one elementKey → one row with latest selected value
5) Session list / owners / delete still work
