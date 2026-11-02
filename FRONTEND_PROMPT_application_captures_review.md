# Frontend Cursor Prompt — Application Captures review badges (checked / unchecked)

Paste this into Cursor on the **Devora21 frontend** repo (Application Captures 3-panel UI).

---

## Goal

Track which screenshots the Super Admin has opened. Show unread-style badges on profiles and sessions. Mark a screenshot **checked** only when the admin clicks to view/expand it — not when merely selecting a profile or session.

Preserve existing layout: date → profiles → sessions → screenshots → lightbox.

---

## Backend contract (shipped)

### Fields

**Owners** (`GET /admin/application-captures/owners`):

```json
{
  "owners": [
    {
      "userId": "…",
      "email": "…",
      "name": "…",
      "captureCount": 12,
      "uncheckedSessionCount": 3,
      "lastCapturedAt": "ISO-8601"
    }
  ]
}
```

- `uncheckedSessionCount` = number of sessions that still have **≥1 unchecked** screenshot.

**Sessions** (`GET /admin/application-captures?userId=&date=&timezone=`):

Each session includes:

```json
{
  "id": "…",
  "tabUrl": "…",
  "sliceCount": 12,
  "uncheckedCount": 5,
  "images": [ /* preview may be partial in list */ ]
}
```

**Session detail / SSE session payloads**:

Each image:

```json
{
  "id": "…",
  "sortOrder": 0,
  "imageUrl": "…",
  "reviewed": false,
  "reviewedAt": null
}
```

Session also has `uncheckedCount`.

New uploads always arrive with `reviewed: false`.

### Mark checked (on open/expand only)

```
POST /admin/application-captures/:sessionId/images/:imageId/review
```

Auth: Super Admin only.

Response:

```json
{
  "ok": true,
  "alreadyReviewed": false,
  "sessionId": "…",
  "imageId": "…",
  "session": { /* full session with images + owner + uncheckedCount */ }
}
```

Idempotent if already reviewed.

### Live SSE (`GET /admin/application-captures/stream`)

| type | Meaning |
|------|---------|
| `session.created` / `session.updated` | New/replaced capture — counts may rise (new images unchecked) |
| `image.reviewed` | Admin checked a screenshot — `session` has updated counts |
| `image.deleted` / `session.deleted` | Adjust badges |

On `image.reviewed` **and** `session.updated`: upsert session; recompute UI badges from `session.uncheckedCount` and whether any session for that profile still has `uncheckedCount > 0`.

---

## UI requirements

### Left — Profile list

- Badge = `uncheckedSessionCount` (hide when `0`).
- Opening a profile must **not** mark anything checked.

### Middle — Session list

- Badge = `uncheckedCount` (hide when `0`).
- Selecting a session must **not** mark screenshots checked.

### Right — Screenshot list

- Visually distinguish `reviewed === false` (e.g. unread dot / stronger border / “New”).
- Checked items look settled/normal.

### Lightbox / expand

- When admin **clicks** a screenshot to open/expand preview:
  1. Call `POST …/images/:imageId/review` immediately (optimistic UI ok).
  2. Apply returned `session` (or SSE) to drop that image’s unchecked state.
  3. Update session badge + profile badge without full page reload.
- Previous/Next in lightbox: mark **each newly shown** image as reviewed when it becomes the active slide (same POST).

### Badge removal

- Session badge disappears when `uncheckedCount === 0`.
- Profile badge decreases when a session flips from “has unchecked” → “all checked”; disappears when `uncheckedSessionCount === 0`.

---

## Client logic sketch

```ts
// On screenshot open (click / lightbox active change):
async function onOpenScreenshot(sessionId: string, imageId: string) {
  // optimistic
  patchLocalImage(sessionId, imageId, { reviewed: true });
  recomputeBadges();

  const res = await api.post(
    `/admin/application-captures/${sessionId}/images/${imageId}/review`
  );
  upsertSession(res.session); // includes uncheckedCount + images[].reviewed
  recomputeProfileUncheckedSessionCounts();
}

function recomputeProfileUncheckedSessionCounts() {
  // For each owner: count local sessions where uncheckedCount > 0
  // Prefer server owners.uncheckedSessionCount on REST refresh;
  // for live updates, derive from sessions you already have loaded + SSE payloads.
}
```

---

## Do NOT

- Mark reviewed on profile select, session select, or list scroll alone.
- Require a separate “Mark as read” button (open = review).
- Poll as primary sync — use existing SSE.

---

## Acceptance

- [ ] New upload → screenshots unchecked → session + profile badges increase (live)
- [ ] Open screenshot → marked checked → badges decrease (live, no refresh)
- [ ] Revisit module later → previously checked stay checked
- [ ] Profile badge = sessions with any unchecked; session badge = unchecked screenshot count
- [ ] Badges hidden at zero
- [ ] Existing gallery / delete / lightbox Prev-Next still work
