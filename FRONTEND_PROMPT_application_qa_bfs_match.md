# Frontend Cursor Prompt — Application Q&A (BFS DOM + DeepSeek)

Copy everything below into the frontend agent.

================================================================================
GOAL
================================================================================

Keep the Super Admin Application Q&A **live** dashboard (SSE — see
`FRONTEND_PROMPT_application_qa_realtime.md`).

The Chrome extension (v2) no longer scrapes parent/sibling text ranges.
It detects user actions, runs **BFS** from the triggered control, and sends
DeepSeek the **original outerHTML** of up to **5 nearest text-bearing DOM
nodes**. DeepSeek returns question/answer match metadata.

Update the UI to show the richer match fields without inventing questions.

Preserve: owners list, sessions list, filters, delete, Super Admin auth,
no-truncate rules, matched vs unmatched sections.

================================================================================
BACKEND CONTRACT (shipped)
================================================================================

Session detail / SSE `session.updated` / `session.created`:

```ts
session: {
  matchedCount: number;
  unmatchedCount: number;

  matchedQa: Array<{
    id: string;
    elementKey: string;
    question: string;          // DeepSeek question
    answer: string;            // user value / selection
    actionType?: string;       // input | change | click | …
    componentType?: string;    // text | radio | checkbox | yesno | dropdown | …
    matchConfidence?: number;
    confidence?: number;       // alias of matchConfidence
    matchStatus: "matched";
    occurredAt: string;
    updatedAt: string;
  }>;

  unmatchedEvents: Array<{
    id: string;
    elementKey: string;
    value: string;
    label?: string;            // element summary — NOT a fake question
    elementLabel?: string;
    matchStatus: "unmatched";
    actionType?: string;
    componentType?: string;
    eventType?: string;
    tagName?: string;
    inputType?: string;
    elementId?: string;
    name?: string;
    cssSelector?: string;
    attributes?: Record<string, string>;
    occurredAt: string;
    updatedAt: string;
  }>;

  inputEvents: Array<{
    matchStatus: "matched" | "unmatched";
    matchedQuestion?: string;
    question: string;
    answer: string;
    value: string;
    actionType?: string;
    componentType?: string;
    // …element fields…
  }>;
}
```

SSE events unchanged: `ready`, `session.created`, `session.updated`, `session.deleted`.
On create/update, replace detail from `matchedQa` + `unmatchedEvents`.

================================================================================
UI REQUIREMENTS
================================================================================

## Matched section (DeepSeek)
Table columns (minimum):
- Question
- Answer
- Action (`actionType`) — optional chip
- Component (`componentType`) — optional chip
- Confidence (`matchConfidence` / `confidence`, show as %)
- Time (`occurredAt` / `updatedAt`)

Rules:
- Never invent a question; only show `question` from the API.
- One row per `elementKey` (upsert). Prefer latest `updatedAt` if duplicates appear.

## Unmatched section (Capture)
Show raw action metadata:
- Time, event/action type, component type, element summary (`label` / selector), value
- “Show details” may expand cssSelector / attributes
- Do **not** display `question` as if it were AI-matched

## Live
Keep “LIVE RECORDING” + streaming indicator from the realtime prompt.
No polling.

================================================================================
EXTENSION PIPELINE (for context — do not reimplement in FE)
================================================================================

User action → resolve control → BFS (≤5 text-bearing nodes, original outerHTML)
→ sync `input_events[]` with `domContext: { strategy:"bfs", triggeredOuterHTML,
  nearbyElements[{distance, relationship, outerHTML, …}] }`
→ DeepSeek match → SSE `session.updated`

================================================================================
ACCEPTANCE
================================================================================

- [ ] Matched table shows question + answer + confidence live over SSE
- [ ] Optional actionType / componentType chips render when present
- [ ] Unmatched shows DOM/action metadata, not invented questions
- [ ] Checkbox/radio/Yes-No answers update the same row (no duplicate questions)
- [ ] No page refresh required for live updates

================================================================================
END PROMPT
================================================================================
