# Frontend Cursor Prompt — Super Admin Application Q&A Dashboard

Copy everything below to the frontend agent/developer.

================================================================================
GOAL
================================================================================

Add a Super Admin console section to browse **job application Q&A recordings**
captured by the Devora21 Chrome extension.

Organize by extension owner → tab/session → question/answer pairs with
timestamps. Support search, detail view, and delete.

Backend APIs already exist (auth: cookie / Bearer; **require Super Admin**):

  GET    /admin/application-qa/owners
  GET    /admin/application-qa/sessions?userId=&q=&page=&limit=
  GET    /admin/application-qa/sessions/:id
  DELETE /admin/application-qa/sessions/:id
  GET    /admin/application-qa/stream         ← live SSE
  POST   /admin/application-qa/stream-ticket  ← short-lived EventSource ticket

Also respect existing Super Admin gateway gate (`/super-admin`) — this page
lives behind the same console auth as other admin tools.

**Live updates (required):** follow `FRONTEND_PROMPT_application_qa_realtime.md`.
If refresh shows data but typing does not update live, the page is not
subscribed with auth — use **fetch + Bearer** to `/admin/application-qa/stream`
(not a bare EventSource).

**Detail content (required):** follow `FRONTEND_PROMPT_application_qa_ai_match.md`.
Show **Matched Q&A** (DeepSeek) + **Unmatched DOM events**. Live via SSE.

================================================================================
UX
================================================================================

Suggested route: `/super-admin/application-qa` (or under existing admin nav).

### Page 1 — Owners list
Call `GET /admin/application-qa/owners`.

Show cards/table:
  - Owner name / email
  - Session count
  - Last synced timestamp
  - Click → filter sessions for that owner

### Page 2 — Sessions list
Call `GET /admin/application-qa/sessions` with optional:
  - `userId` (owner filter)
  - `q` (search URL / title / owner email)
  - pagination `page`, `limit`

Columns:
  - Owner
  - Tab URL (full URL visible — do NOT ellipsis-truncate)
  - Page title (full text, wrap if needed)
  - Status (`recording` | `paused`)
  - Item count
  - Updated / lastSyncedAt (full datetime, no `…` clip)
  - Actions: View, Delete

**CRITICAL — no cutting content in the sessions table**
Super Admins must see the **full** URL, page title, and timestamp in the list
(and full Q&A on the detail page). Do NOT use `text-overflow: ellipsis` /
`truncate` / single-line clamp on these cells.

Required layout behavior:
  - Table: `table-layout: auto` (or fixed with generous widths); allow horizontal
    scroll on the table wrapper if the viewport is narrow
  - TAB URL: render as a wrapping link (`break-all` / `overflow-wrap: anywhere`);
    show the complete `tabUrl` string; `title` attribute optional but not a substitute
  - PAGE TITLE: wrap to multiple lines; never truncate mid-string with `…`
  - UPDATED: show full locale datetime (e.g. `2026/10/15 Thu 15:31:42`), not clipped
  - On small screens: horizontal scroll is OK; hiding text behind ellipsis is not

### Page 3 — Session detail
Call `GET /admin/application-qa/sessions/:id`.

Show:
  - Owner block
  - Full URL + page title + status + timestamps (no truncation)
  - Table of Q&A:
      Question | Answer | Updated at
  - Prefer `session.questionsAnswers` (or `questions_answers`)
  - Questions and answers must wrap fully; no ellipsis clamp

Delete: confirm → `DELETE /admin/application-qa/sessions/:id` → toast → back to list.

================================================================================
API SHAPES (success)
================================================================================

Owners:

```json
{
  "owners": [
    {
      "userId": "…",
      "email": "owner@example.com",
      "name": "Owner Name",
      "sessionCount": 3,
      "lastSyncedAt": "2026-10-15T12:00:00.000Z"
    }
  ]
}
```

Sessions list:

```json
{
  "page": 1,
  "limit": 25,
  "total": 10,
  "sessions": [
    {
      "id": "…",
      "userId": "…",
      "tabUrl": "https://…",
      "pageTitle": "Apply — Acme",
      "status": "recording",
      "itemCount": 12,
      "updatedAt": "…",
      "lastSyncedAt": "…",
      "owner": { "id": "…", "email": "…", "name": "…" }
    }
  ]
}
```

Session detail:

```json
{
  "session": {
    "id": "…",
    "tabUrl": "https://…",
    "status": "paused",
    "owner": { "email": "…", "name": "…" },
    "questionsAnswers": [
      {
        "id": "…",
        "question": "Years of experience?",
        "answer": "10 years",
        "updatedAt": "…"
      }
    ],
    "questions_answers": [
      { "question": "Years of experience?", "answer": "10 years" }
    ]
  }
}
```

================================================================================
AUTH / ERRORS
================================================================================

- Same Super Admin session as other `/admin/*` calls
- 401 → re-auth; 403 → not super-admin
- Never call extension owner endpoints from this dashboard

================================================================================
OUT OF SCOPE
================================================================================

- Do not build the Chrome extension UI here
- Do not show password/payment fields (backend strips them)
- Do not add gateway credential changes on this page

================================================================================
ACCEPTANCE
================================================================================

1) Super Admin sees owners with session counts
2) Can filter/search sessions by owner and URL text
3) Sessions table shows **complete** tab URL, page title, and datetime (no `…` cut off)
4) Detail shows all Q&A + timestamps in full
5) Delete removes session from lists
6) Non–super-admin cannot load the page / APIs return 403
