# Cursor frontend prompt — Fast / small rrweb replay (optimized backend)

Paste into the **frontend** Cursor chat. Backend + extension now ship **slim recordings** and **gzip events on B2**. Detail API no longer embeds full events by default (that was making open slow).

---

## Goal

Make Super Admin rrweb replay **start fast** and work with **smaller** session files.

Acceptable quality: **full color** TV, skip long idle gaps. Oversight only — not pixel-perfect video.

---

## Backend contract (updated)

### Detail (fast)

`GET /admin/rrweb-sessions/:id`

Returns metadata + **signed** `eventsUrl` — **does not** include `events` by default.

```json
{
  "id": "uuid",
  "primaryUrl": "https://…",
  "pageTitle": "…",
  "status": "uploaded",
  "eventCount": 1200,
  "durationMs": 180000,
  "frameCount": 2,
  "eventsUrl": "https://…signed…/events.json.gz?Authorization=…",
  "eventsEncoding": "gzip",
  "replayHints": {
    "skipInactive": true,
    "preferTopFrame": true,
    "grayscaleOk": false
  },
  "reviewed": false,
  "startedAt": "ISO",
  "endedAt": "ISO",
  "user": { }
}
```

Legacy/debug only: `GET /admin/rrweb-sessions/:id?includeEvents=1` (slow — avoid in production UI).

`eventsEncoding`: `"gzip"` | `"json"` | `null`  
Older sessions may still be plain `events.json` (`"json"`).

---

## Required FE replay flow (fast start)

1. Open session → call detail API (no embed).
2. Show player shell immediately (loading state).
3. **`GET /admin/rrweb-sessions/:id/events`** with Super Admin auth (use `detail.eventsPath`).  
   - This proxies B2 through the API and **fixes browser CORS** (`Failed to fetch` when calling B2 directly).
4. Read `X-Events-Encoding` or magic bytes `1f 8b` → gunzip if needed.
5. `JSON.parse` → `{ frames: [...] }`.
6. Pick **top frame first**.
7. Mount `rrweb-player` with that frame’s `events` only + `skipInactive: true`.
8. Lazy-load other frames after first paint.
9. **Do not** apply `filter: grayscale(1)` — TV must be full color.

### Example loader

```ts
async function loadRrwebPayloadFromApi(apiBase: string, sessionId: string, token: string) {
  const res = await fetch(`${apiBase}/admin/rrweb-sessions/${sessionId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`events ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const isGzip =
    res.headers.get("X-Events-Encoding") === "gzip" ||
    (buf[0] === 0x1f && buf[1] === 0x8b);
  let jsonText: string;
  if (isGzip) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    jsonText = await new Response(stream).text();
  } else {
    jsonText = new TextDecoder().decode(buf);
  }
  return JSON.parse(jsonText);
}
```

**Do not** `fetch(session.eventsUrl)` in the browser — Backblaze CORS → `Failed to fetch`.

---

## Do / Don’t

| Do | Don’t |
|----|--------|
| `GET …/rrweb-sessions/:id/events` (API proxy) | `fetch(eventsUrl)` to B2 from the browser |
| Gunzip when encoding/magic says gzip | Assume always plain JSON |
| Top frame first + `skipInactive` | Concat all frames into one player |
| Full-color player (no grayscale) | Use `?includeEvents=1` by default |

---

## What extension/backend already do

- Slim record: no inline CSS/images, sampled mouse/scroll, block `img/video`, idle pause (3 min) + pause when tab hidden  
- B2 object: `events.json.gz`  
- Detail API: signed URL + hints, no default event embed  

New recordings will be much smaller/faster. Old fat sessions may still open slowly until re-recorded.

---

## Acceptance

- [ ] Opening a session shows player UI before events finish downloading  
- [ ] Events load from `eventsUrl` (gzip handled)  
- [ ] Playback starts on top frame; idle gaps skipped  
- [ ] Player is full color (no grayscale filter)  
- [ ] Frame switcher for iframes after first playable frame  
- [ ] Review/delete/SSE still work as before  
