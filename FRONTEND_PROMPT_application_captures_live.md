# Frontend Cursor Prompt — Application Captures (3-panel + live SSE)

Paste this into Cursor on the **Devora21 frontend** repo.

---

## Recommendation: Server-Sent Events (SSE)

Use **SSE** (same pattern as Application Q&A), not WebSockets.

Why SSE fits this architecture:

- Server → client push only (extension uploads; admin UI listens)
- Works over plain HTTPS with existing Super Admin auth
- Already proven in this product (`/admin/application-qa/stream`)
- Simpler than WebSockets (no custom protocol / heartbeat framing)

Do **not** poll as the primary sync mechanism. Polling is fallback only if SSE is offline.

---

## Layout (required)

Replace / build **Super Admin → Application Captures** as a three-panel workspace:

```
┌─────────────────────────────────────────────────────────────┐
│  TOP: Date selector (calendar day + timezone)               │
├──────────────┬────────────────────┬─────────────────────────┤
│ LEFT         │ MIDDLE             │ RIGHT                   │
│ Profile list │ URL session list   │ Screenshot slices       │
│ (owners)     │ for profile+date   │ for selected session    │
└──────────────┴────────────────────┴─────────────────────────┘
```

### Top — Date selector

- Pick a calendar day (`YYYY-MM-DD`) and timezone (default `America/New_York`, same as Q&A).
- Changing date reloads middle list for the selected profile (keep profile selection).

### Left — Profile list

- Source: `GET /admin/application-captures/owners`
- Show email / name + capture count + last captured time.
- Selecting a profile loads middle panel for that `userId` + current date.

### Middle — URL session list

- Source: `GET /admin/application-captures?userId=&date=&timezone=&page=&limit=`
- One row per capture session (URL / page title / sliceCount / capturedAt).
- Selecting a session loads right panel from `GET /admin/application-captures/:id`
  (full `images[]` ordered by `sortOrder`).

### Right — Screenshots

- Thumbnail / list of slices for the selected session (top → bottom).
- Click a slice → **large preview modal/lightbox** with:
  - **Previous** / **Next** (wrap or stop at ends — prefer stop)
  - Keyboard ← / → optional
  - Close without losing middle/right selection

Preserve selection state when live events arrive (see below).

---

## Backend APIs (shipped)

Auth: Super Admin (same as other `/admin/*`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/application-captures/owners` | Left panel profiles |
| `GET` | `/admin/application-captures?userId=&date=&timezone=&q=&page=&limit=` | Middle panel sessions |
| `GET` | `/admin/application-captures/:id` | Right panel + lightbox images |
| `DELETE` | `/admin/application-captures/:id` | Delete URL session (+ B2 cleanup) |
| `DELETE` | `/admin/application-captures/:id/images/:imageId` | Delete one screenshot |
| `POST` | `/admin/application-captures/stream-ticket` | Short-lived SSE ticket |
| `GET` | `/admin/application-captures/stream` | **SSE live stream** |

Delete UX details: see `FRONTEND_PROMPT_application_captures_delete.md`.

### List query notes

- `date` = calendar day in `timezone` (filters `capturedAt`)
- Aliases accepted: `day`, `tz`
- Response may echo `{ date, timezone }` when date filter is used
- List rows include `owner` + first image preview; detail includes **all** `images[]` with signed `imageUrl`

### Live SSE

```
POST /admin/application-captures/stream-ticket
  → { ok, ticket, expiresIn, streamPath }

GET  /admin/application-captures/stream
  → text/event-stream
```

Auth for stream (any one):

| Method | How |
|--------|-----|
| **Preferred** | `fetch(streamUrl, { headers: { Authorization: Bearer <accessToken> }, credentials: "include" })` + read `response.body` |
| Cookie | `EventSource(url, { withCredentials: true })` if cookies already auth `/admin/*` |
| Query JWT | `?access_token=` or `?token=` |
| Ticket | `POST /stream-ticket` then `EventSource(API + streamPath)` |

Events (JSON in `data:`). Every payload includes `type`:

| type | Fields |
|------|--------|
| `ready` | `ok`, `at`, `subscribers` |
| `session.created` | `at`, `session` (full: images, owner, tabUrl, capturedAt, …) |
| `session.updated` | same |
| `session.deleted` | `at`, `sessionId`, `userId?` |
| `image.deleted` | `at`, `sessionId`, `imageId`, `userId?`, `session` (remaining or `null`) |
| `image.reviewed` | `at`, `sessionId`, `imageId`, `userId?`, `session` (updated counts) |

Review badges (unchecked counts): see `FRONTEND_PROMPT_application_captures_review.md`.

On connect, server may **replay ~25 recent** events — upsert by `session.id`.

Heartbeat: SSE comments `: ping …` (ignore).

Connect **directly to the API origin** (do not buffer through a Next.js route).

---

## Live sync rules (critical)

When `session.created` / `session.updated` arrives:

1. Upsert into local store by `session.id`.
2. Update **left** owner counts / lastCaptured if needed (or soft-refresh owners).
3. If event `session.userId` / `owner.userId` **and** calendar day of `capturedAt` match the **current left profile + top date**, upsert into **middle** list (sort by `capturedAt` desc).
4. If the event session id === **currently selected** middle session, refresh **right** images from the event payload (prefer event `images[]` over another GET).
5. If lightbox is open on that session, keep current `sortOrder` index if still valid; otherwise clamp to last image. Do **not** close the lightbox unexpectedly.
6. If the event is for another profile/date, still store it, but **do not** steal focus / change selection.

When `session.deleted` arrives:

- Remove from middle if present.
- If it was selected, clear right panel + close lightbox.
- Update left counts if practical.

When `image.deleted` arrives:

- If `session` is null → same as session deleted.
- Else replace the session’s images / sliceCount; if lightbox was on the deleted image, move to nearest remaining or close.

Show a small **Live / Reconnecting / Offline** indicator near the date bar.

---

## Preferred SSE client sketch

```ts
async function connectCaptureLive(opts: {
  apiBase: string;
  getAccessToken: () => string | null | Promise<string | null>;
  onEvent: (ev: {
    type: string;
    session?: any;
    sessionId?: string;
    userId?: string;
    at?: string;
  }) => void;
  onStatus: (s: "connecting" | "live" | "reconnecting" | "offline") => void;
  signal?: AbortSignal;
}) {
  opts.onStatus("connecting");
  const token = await opts.getAccessToken();
  if (!token) {
    opts.onStatus("offline");
    throw new Error("Missing access token for Application Captures SSE");
  }

  const url = `${opts.apiBase.replace(/\/$/, "")}/admin/application-captures/stream`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    credentials: "include",
    signal: opts.signal,
  });

  if (!okOrBody(res)) {
    opts.onStatus("reconnecting");
    throw new Error(`SSE HTTP ${res.status}`);
  }

  opts.onStatus("live");
  // Parse SSE frames from res.body; for each data: JSON → onEvent(JSON.parse)
  // On abort/error → backoff reconnect
}
```

Also listen for named events if using EventSource (`session.created`, etc.) **and** read `payload.type`.

---

## Out of scope

- Do not build extension upload UI.
- Do not remove Profile / Resume / Security modules.
- Backend already stores JPEGs on Backblaze; just display signed `imageUrl`s.

---

## Acceptance

- [ ] Top date + left profiles + middle sessions + right slices
- [ ] Click slice → large preview with Previous / Next
- [ ] New extension capture appears in the correct profile/date/session within ~1s with no refresh
- [ ] Current selection + open lightbox preserved across live updates
- [ ] Live indicator works; reconnects after network blip
- [ ] Delete URL session from middle (confirm) — live for all admins
- [ ] Delete screenshot from right panel + lightbox — live for all admins
- [ ] Last screenshot delete removes the session
- [ ] Matches existing Super Admin design system
