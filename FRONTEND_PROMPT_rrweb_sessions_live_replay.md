# Cursor frontend prompt — rrweb sessions: live sync + recording badge + fast replay

Paste into the **frontend** Cursor chat. Backend/extension already sync tab sessions while recording (gzip events on B2). Extension side panel shows **Recording now** (open tabs) vs **Finished on server**.

---

## Product model

| State | Meaning | List UI | Replay |
|-------|---------|---------|--------|
| `recording` | Tab still open; events flushing to B2 | **Recording** badge | **Enabled if** `replayable === true` (events already on B2). Else disabled with tooltip “Waiting for first sync…” |
| `uploaded` | Tab closed; session finalized | Finished / no live badge | **Always enabled** when `eventsUrl` present |
| `failed` / `deleted` | Error or removed | Hide or show error | Disabled |

- Extension: open tab → session appears in “Recording now”; tab close → session finishes and leaves that list (moves to finished on server).
- Frontend Super Admin: **must mirror backend** via list API + SSE (source of truth is server, not the extension UI).

---

## APIs (use these)

### List (both live + finished)

`GET /admin/rrweb-sessions?userId=&q=&date=&timezone=&page=&limit=`

Each session includes:

```ts
{
  id: string
  status: "recording" | "uploaded" | "failed" | "deleted"
  primaryUrl: string
  pageTitle: string | null
  eventCount: number
  durationMs: number | null
  frameCount: number
  eventsUrl: string | null          // signed when detail/list signs URLs
  eventsEncoding: "gzip" | "json" | null
  replayable: boolean               // true if eventsUrl + eventCount>0 and status recording|uploaded
  replayHints: {
    skipInactive: true
    preferTopFrame: true
    grayscaleOk: false              // full-color TV — do NOT grayscale
    lazyIframeFrames: true          // IFRAME tabs; load events on tab click
    playOneFrameAtATime: true       // never merge frames into one player
    liveReplay: boolean             // true when status===recording
  }
  reviewed: boolean
  startedAt: string
  endedAt: string | null
  user?: { id, email, name, ... }
}
```

**UI list rules**
- Show `recording` rows with a red/pulsing **Recording** badge — **only if `status === "recording"`**.
- Show `uploaded` **without** that badge (Finished / Uploaded). Never keep Recording after SSE `session.updated` flips status.
- Optional filter chips: All | Recording | Finished (`recording` vs `uploaded`).
- Sort: recording first, then `startedAt` desc (or keep API order and pin recording).
- **Profiles / owners left column: no unchecked count badge** (do not render `uncheckedCount`).

### Detail (fast — do not embed events)

`GET /admin/rrweb-sessions/:id`

Same fields plus:

- `eventsPath`: `/admin/rrweb-sessions/:id/events` — **prefer this**
- `eventsUrl`: signed B2 URL (may fail in browser with CORS → **"Failed to fetch"**)

**Do not** use `?includeEvents=1` in normal UI.

### Events download (required for replay — fixes CORS)

`GET /admin/rrweb-sessions/:id/events`  
Auth: same Super Admin Bearer / session as other admin APIs.

Returns raw bytes:

- `Content-Type: application/gzip` or `application/json`
- Header `X-Events-Encoding: gzip|json`

**Always load events via `eventsPath` (same API origin).** Do not `fetch(eventsUrl)` from the browser unless B2 CORS is configured.

### Live SSE

1. `POST /admin/rrweb-sessions/stream-ticket`
2. `EventSource(streamPath)`
3. Events: `session.created` | `session.updated` | `session.deleted` | `session.reviewed` | `ready`

On `session.created` / `updated`: upsert into list (status may be `recording` then later `uploaded`).  
On `deleted`: remove row.  
If detail open for that id: refresh detail metadata; if player already open and status flips to `uploaded`, optional toast “Recording finished”.

### Review / delete

- Review endpoint still exists but **do not show an unchecked / unreviewed count badge** on owners.
- `DELETE /admin/rrweb-sessions/:id`

---

## Replay rules (important)

### Finished (`uploaded`)
- Replay **enabled** if `eventsUrl` and `eventCount > 0`.
- Load via `eventsPath` → top frame → `skipInactive: true` → **full color** (no grayscale).

### In progress (`recording` only — check `status`, not `replayHints.liveReplay` alone)
- If `status !== "recording"`: treat as finished (no Recording badge, no partial subtitle).
- If `replayable === true` (partial events already synced):  
  - Enable **Play (live / partial)**  
  - Badge: Recording  
  - Subtitle: “Partial replay — more events may appear; refresh to update”  
  - On play: fetch via `eventsPath` again (don’t cache forever); same fast loader as finished  
- If `replayable === false`:  
  - **Disable** play button  
  - Tooltip: “Waiting for first upload sync…”

Do **not** block the whole page waiting for recording to finish.

---

## Fastest start play (required)

1. Click session → open detail shell **immediately** (title, badge, disabled/enabled play).  
2. Fetch detail JSON (small).  
3. If not `replayable` → stop (show waiting).  
4. `GET ${API}${detail.eventsPath}` with auth → ArrayBuffer → gunzip if needed → parse.  
5. Mount player with **top frame only** first.  
6. `skipInactive: true`.  
7. **Full-color TV** — do **not** set `filter: grayscale(1)` (respect `replayHints.grayscaleOk === false`).  
8. Build TOP + IFRAME tabs from `frames[]`; remount **one frame at a time** on tab click (lazy; no merged timeline). See `FRONTEND_PROMPT_rrweb_sessions_frame_tabs.md`.  
9. Never use `?includeEvents=1` for default path.  
10. **Never** `fetch(detail.eventsUrl)` in the browser (B2 CORS → Failed to fetch).

### Loader sketch

```ts
async function loadRrwebPayloadFromApi(apiBase: string, sessionId: string, token: string) {
  const res = await fetch(`${apiBase}/admin/rrweb-sessions/${sessionId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`events ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const headerEnc = res.headers.get("X-Events-Encoding");
  const isGzip =
    headerEnc === "gzip" ||
    (buf[0] === 0x1f && buf[1] === 0x8b);
  let text: string;
  if (isGzip) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(buf);
  }
  return JSON.parse(text) as {
    frames: Array<{ frameKey: string; isTop?: boolean; events: any[] }>;
  };
}

function pickTopFrame(payload: { frames: any[] }) {
  return (
    payload.frames.find((f) => f.isTop) ||
    payload.frames.find((f) => f.frameKey === "top") ||
    payload.frames[0]
  );
}
```

```ts
// Play button
if (!session.replayable) return; // disabled
const detail = await api.get(`/admin/rrweb-sessions/${id}`);
const payload = await loadRrwebPayloadFromApi(API_BASE, id, accessToken);
const frame = pickTopFrame(payload);
// Full color — do not grayscale the player
el.style.filter = "";
new rrwebPlayer({
  target: el,
  props: {
    events: frame.events,
    skipInactive: true,
    showController: true,
    autoPlay: false,
  },
});
```

---

## Sync behavior to match extension

| Extension | Backend | Frontend |
|-----------|---------|----------|
| Tab opens + On | `POST` start → status `recording` | SSE `session.created` → list row + Recording badge |
| Events flush | `POST …/events` → gzip grows | Optional: if detail open, “Refresh replay” |
| Tab closes | `POST …/complete` → `uploaded` | SSE `session.updated` → badge clears, full replay |

Polling fallback if SSE drops: refetch list every 15–30s while Super Admin page is open.

---

## Acceptance checklist

- [ ] List shows `recording` and `uploaded` from backend (SSE or poll)  
- [ ] Recording badge on `recording` only  
- [ ] Play disabled when `replayable === false`  
- [ ] Play enabled for `recording` when `replayable` (partial) and for all finished with events  
- [ ] Player opens fast: shell first, then gzip `eventsUrl`, top frame, `skipInactive`  
- [ ] No default `includeEvents=1`  
- [ ] Review on open; delete works; TV is full color (no grayscale)  

---

## Out of scope

- Extension chrome UI (already has Recording now list)  
- Re-recording old fat sessions (new ones are slim/gzip)
