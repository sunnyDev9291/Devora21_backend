# Frontend Cursor Prompt — Delete URL sessions & screenshot items

Paste this into Cursor on the **Devora21 frontend** repo (Application Captures 3-panel UI).

---

## Goal

Super Admin must be able to delete:

1. An entire **URL session** (middle panel row)
2. Individual **screenshot items** (right panel / lightbox)

Deletions must sync live over SSE (no refresh). Confirm before destructive actions.

---

## APIs (shipped)

Auth: Super Admin Bearer / cookie (same as other `/admin/*`).

| Action | Method | Path |
|--------|--------|------|
| Delete URL session | `DELETE` | `/admin/application-captures/:sessionId` |
| Delete one screenshot | `DELETE` | `/admin/application-captures/:sessionId/images/:imageId` |

### Delete session response

```json
{ "ok": true, "sessionId": "uuid" }
```

- Soft-deletes the session in DB
- Best-effort removes JPEG objects from Backblaze
- SSE: `session.deleted`

### Delete screenshot response

```json
{
  "ok": true,
  "sessionDeleted": false,
  "sessionId": "uuid",
  "imageId": "uuid",
  "session": { /* remaining session + images + owner */ }
}
```

If it was the **last** image:

```json
{
  "ok": true,
  "sessionDeleted": true,
  "sessionId": "uuid",
  "imageId": "uuid",
  "session": null
}
```

- SSE: `image.deleted` (always), then `session.updated` **or** `session.deleted` if emptied

---

## UI requirements

### Middle panel — URL session

- Per row: **Delete** control (icon/button)
- Confirm: “Delete this capture session and all screenshots?”
- On success (or SSE `session.deleted`):
  - Remove row from middle list
  - If it was selected → clear right panel + close lightbox
  - Refresh left owner counts if needed

### Right panel — screenshots

- Per thumbnail / list item: **Delete** control
- Confirm: “Delete this screenshot?”
- On success:
  - Remove that image from right list
  - If lightbox was on that image → jump to nearest remaining (prev preferred) or close if none
  - Update middle row `sliceCount` from returned `session`

### Lightbox

- Also expose **Delete current** in the large preview
- Same API as right-panel item delete
- Previous/Next still work on remaining images

### Empty session rule

If the last screenshot is deleted, backend deletes the whole session — treat like session delete in the UI.

---

## Live SSE handling (extend existing stream)

Stream: `GET /admin/application-captures/stream`

| type | What to do |
|------|------------|
| `image.deleted` | Remove `imageId` from local session; if `session` is null → treat as session gone; else replace local session with payload `session` |
| `session.updated` | Upsert session (images, sliceCount) without stealing selection |
| `session.deleted` | Remove session; clear selection if needed |

Optimistic UI is fine: apply DELETE response immediately, then reconcile with SSE.

---

## Out of scope

- Do not build bulk multi-select unless already easy
- Do not change extension upload flow
- Do not hard-require B2 cleanup success (backend already best-effort)

---

## Acceptance

- [ ] Delete session from middle panel (with confirm)
- [ ] Delete screenshot from right panel and from lightbox
- [ ] Last-image delete removes the session from middle
- [ ] Other Super Admin clients see deletes via SSE without refresh
- [ ] Selection / lightbox stay coherent after delete
