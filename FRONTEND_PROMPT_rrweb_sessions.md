# Cursor frontend prompt — Super Admin rrweb session replay

Paste this into the **frontend** Cursor chat (Devora21 web app). Backend + Chrome extension already ship rrweb apply-attempt recordings.

---

## Goal

Replace (or supersede) the Super Admin **Application Captures** screenshot gallery with an **rrweb session replay** workspace so managers can watch team members’ job-application attempts like a video (DOM replay), including cross-origin iframes when the extension recorded those frames.

Keep the existing Super Admin shell (gateway gate, left users list, center list, right detail) if that layout already exists for captures — swap the detail pane from image gallery → rrweb player.

---

## Product rules

1. **Unit of work = one apply attempt** (`RrwebSession`), not every URL hop.
2. Sessions may span SPA navigations and related tabs; UI shows `primaryUrl` + `pageTitle` + duration.
3. **Auto-uploaded** from the extension — no “approve screenshots” step.
4. **No unchecked / unreviewed count badge** on the owners (profiles) list. Do not render a red count pill. `uncheckedCount` is always `0` from the API — ignore it.
5. Live updates via SSE (same pattern as Application Captures).
6. Passwords are masked at record time; still treat replay as sensitive PII.
7. **Recording badge** only when `status === "recording"`. When `status === "uploaded"`, never show Recording / “Partial replay”.

---

## Backend APIs (already live)

Base: authenticated Super Admin (`Authorization: Bearer` or gateway session). SSE uses short-lived ticket.

### Owners (left panel)

`GET /admin/rrweb-sessions/owners`

```json
{
  "owners": [
    {
      "userId": "uuid",
      "email": "user@…",
      "name": "First Last",
      "sessionCount": 12,
      "uncheckedCount": 0,
      "lastStartedAt": "ISO"
    }
  ]
}
```

**Do not show an unchecked / unreviewed badge** next to owner names. Ignore `uncheckedCount` (always 0).

### List (center panel)

`GET /admin/rrweb-sessions?userId=&q=&date=YYYY-MM-DD&timezone=America/Los_Angeles&page=1&limit=25`

```json
{
  "sessions": [
    {
      "id": "uuid",
      "userId": "uuid",
      "clientSessionId": "uuid",
      "primaryUrl": "https://…",
      "pageTitle": "…",
      "status": "recording|uploaded|failed|deleted",
      "eventCount": 1840,
      "durationMs": 125000,
      "frameCount": 2,
      "eventsUrl": "https://…signed…",
      "reviewed": false,
      "reviewedAt": null,
      "startedAt": "ISO",
      "endedAt": "ISO",
      "user": { "id", "email", "firstName", "lastName", "name" }
    }
  ],
  "total": 12,
  "page": 1,
  "limit": 25
}
```

Prefer listing **uploaded** (and optionally in-progress `recording`) sessions. Show duration as `mm:ss`. Unreviewed row: subtle badge.

### Detail + events (right panel / player)

`GET /admin/rrweb-sessions/:id`

Returns the list fields **plus**:

```json
{
  "events": {
    "version": 1,
    "clientSessionId": "uuid",
    "frames": [
      {
        "frameKey": "top",
        "href": "https://…",
        "isTop": true,
        "events": [ /* rrweb event objects */ ]
      },
      {
        "frameKey": "iframe:https://boards.greenhouse.io/…",
        "href": "https://…",
        "isTop": false,
        "events": [ /* … */ ]
      }
    ]
  },
  "eventsUrl": "https://…signed download of same JSON…"
}
```

**Replay strategy (recommended):**

1. Prefer inlined `events` from GET detail (already signed fetch done server-side when loading B2).
2. Fallback: `fetch(eventsUrl)` if `events` missing.
3. Install `rrweb-player` (or `rrweb` replay) in the frontend.
4. Default: play the **top** frame (`isTop === true` or `frameKey === "top"`).
5. If multiple frames: tab/segment switcher (“Main page” / each iframe) — each frame has its own event timeline; do **not** naively concat unrelated frame streams into one player unless you implement multi-player sync (v1: switcher is enough).
6. Player UI: play/pause, scrubber, speed 1x/2x/4x, fullscreen.

Example mount:

```ts
import rrwebPlayer from 'rrweb-player';
import 'rrweb-player/dist/style.css';

const frame = data.events.frames.find(f => f.isTop) || data.events.frames[0];
new rrwebPlayer({
  target: containerEl,
  props: {
    events: frame.events,
    width: containerEl.clientWidth,
    height: Math.max(480, Math.floor(window.innerHeight * 0.55)),
    autoPlay: false,
    showController: true,
  },
});
```

Use a compatible rrweb major with the recorder (`rrweb@2.0.0-alpha.4` on backend/extension). Prefer matching `rrweb-player` alpha for v2 events.

### Mark reviewed

`POST /admin/rrweb-sessions/:id/review`

Call when Super Admin **opens** the session detail / starts playback (once per open is fine). Response includes updated `session` with `reviewed: true`.

### Delete

`DELETE /admin/rrweb-sessions/:id` — removes DB row + B2 events JSON. Confirm dialog.

### Live SSE

1. `POST /admin/rrweb-sessions/stream-ticket` → `{ ticket, expiresIn, streamPath }`
2. `EventSource(`${API}${streamPath}`)` (ticket already in query)
3. Events: `ready`, `session.created`, `session.updated`, `session.deleted`, `session.reviewed`
4. Heartbeat comments every ~15s; reconnect + new ticket on error
5. On event: refresh owners badge + merge/replace session in the active user’s list; if detail open and same id, refresh detail (don’t interrupt active scrub unless status terminal)

Mirror the Application Captures SSE client if present.

---

## UX layout

**Route suggestion:** `/super-admin/rrweb-sessions` (or replace `/super-admin/application-captures`).

Three columns:

| Left | Center | Right |
|------|--------|-------|
| Owners (no unchecked badge) | Date filter + search + session list | Metadata + rrweb player + frame tabs + Delete |

Metadata chips: status, eventCount, frameCount, duration, started/ended, primaryUrl (link). Recording badge only when `status === "recording"`.

Empty states: no owners / no sessions for day / session has 0 events.

---

## Remove / deprecate

- If Application Captures UI was only for screenshot oversight, hide or remove that nav entry and point managers here.
- Do **not** remove Application Q&A unless already removed by a prior prompt.

---

## Out of scope

- Remote control / injecting clicks into the live browser
- Editing rrweb events
- Multi-frame synchronized dual player (nice-to-have later)

---

## Acceptance checklist

- [ ] Owners list loads with **no** unchecked count badge
- [ ] Selecting a user + date lists apply-attempt sessions
- [ ] Opening a session loads events and rrweb-player scrubs/plays
- [ ] Iframe frames selectable when `frameCount > 1`
- [ ] Recording badge clears when status becomes `uploaded`
- [ ] Delete removes session from list + SSE notifies other tabs
- [ ] SSE creates/updates sessions live without full page reload
- [ ] Works behind Super Admin gateway auth
