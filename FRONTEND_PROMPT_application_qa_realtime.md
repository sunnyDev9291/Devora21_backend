# Frontend Cursor Prompt — FIX Live Super Admin Application Q&A (REQUIRED)

Copy everything below into the frontend agent. This is a **bugfix**: refresh shows
new Q&A, but the dashboard does **not** update while the extension user types.

================================================================================
WHY IT IS BROKEN (ROOT CAUSE)
================================================================================

Extension → backend sync **already works** (that is why refresh shows data).

Live UI requires an open **SSE** connection to:

  GET /admin/application-qa/stream

Common frontend mistakes that cause “not realtime”:

1. **Never subscribed** to `/admin/application-qa/stream` on the Q&A page.
2. Used `new EventSource(url)` **without auth**. Admin REST calls send
   `Authorization: Bearer …`, but EventSource **cannot** set headers → 401 →
   silent failure → only refresh (REST) shows updates.
3. Listened only to `es.onmessage` while ignoring that events are also named
   (`session.created`, etc.) — backend now sends **both**; still handle `type`.
4. Proxied SSE through a Next.js/BFF route that **buffers** the body — live
   events never flush. Connect **directly to the API origin**.

================================================================================
GOAL
================================================================================

- Apply Page detected → session row appears within ~1s (no refresh).
- User types / checks boxes in extension → Q&A detail, counts, timestamps update
  live.
- Show Live / Reconnecting indicator.
- Do **not** rely on interval polling as the primary mechanism.

================================================================================
BACKEND CONTRACT (updated)
================================================================================

### REST (unchanged)

```
GET    /admin/application-qa/owners
GET    /admin/application-qa/sessions?userId=&q=&date=&timezone=&page=&limit=
GET    /admin/application-qa/sessions/:id
DELETE /admin/application-qa/sessions/:id
```

### Live stream

```
POST /admin/application-qa/stream-ticket   → { ticket, expiresIn, streamPath }
GET  /admin/application-qa/stream           → text/event-stream
```

Auth for `GET /stream` (any one):

| Method | How |
|--------|-----|
| **Preferred** | `fetch(streamUrl, { headers: { Authorization: Bearer <same token as admin API> }, credentials: "include" })` then read `response.body` |
| Cookie | `EventSource(url, { withCredentials: true })` if admin already uses httpOnly cookies on API host |
| Query JWT | `?access_token=<accessJwt>` or `?token=` |
| Ticket | `POST /stream-ticket` (with normal Bearer/cookie) → open `EventSource(API + streamPath)` |

Events (JSON in `data:`). Every payload includes `type`:

| type                 | Fields |
|----------------------|--------|
| `ready`              | `ok`, `at` |
| `session.created`    | `at`, `session` (full, with `questionsAnswers`, `owner`, `itemCount`) |
| `session.updated`    | same |
| `session.deleted`    | `at`, `sessionId`, `userId?` |

Server may replay ~25 recent events on connect — upsert by `session.id`.

Heartbeat: SSE comments `: ping …` (ignore).

================================================================================
REQUIRED IMPLEMENTATION (prefer fetch + Bearer)
================================================================================

Do **not** use bare `EventSource` without a token unless cookies alone already
authenticate every `/admin/*` call.

```ts
async function connectApplicationQaLive(opts: {
  apiBase: string;           // e.g. https://api.example.com  (NOT the Next origin)
  getAccessToken: () => string | null | Promise<string | null>;
  onEvent: (ev: { type: string; session?: any; sessionId?: string; at?: string }) => void;
  onStatus: (s: "connecting" | "live" | "reconnecting" | "offline") => void;
  signal?: AbortSignal;
}) {
  opts.onStatus("connecting");
  const token = await opts.getAccessToken();
  if (!token) {
    opts.onStatus("offline");
    throw new Error("Missing access token for Application Q&A SSE");
  }

  const url = `${opts.apiBase.replace(/\/$/, "")}/admin/application-qa/stream`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    credentials: "include",
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    opts.onStatus("reconnecting");
    throw new Error(`SSE HTTP ${res.status}`);
  }

  opts.onStatus("live");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const dataLines = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      try {
        const ev = JSON.parse(dataLines.join("\n"));
        if (ev?.type) opts.onEvent(ev);
      } catch {
        /* ignore parse errors / heartbeats */
      }
    }
  }
}
```

Reconnect with exponential backoff (1s → 15s max) when the loop ends or throws.
Abort the fetch on page unmount.

### EventSource alternative (only if you cannot use fetch stream)

```ts
// 1) POST /admin/application-qa/stream-ticket with normal auth headers
// 2) EventSource(`${apiBase}${streamPath}`, { withCredentials: true })
// Listen to BOTH:
//   es.addEventListener("session.created", ...)
//   es.addEventListener("session.updated", ...)
//   es.addEventListener("session.deleted", ...)
//   es.addEventListener("ready", ...)
// AND es.onmessage = (msg) => handle(JSON.parse(msg.data))  // dedupe by type+at+id
```

================================================================================
UI WIRING
================================================================================

On `/super-admin/application-qa` (list + detail):

1. Initial `GET /sessions` (+ owners).
2. Start live connect for the page lifetime.
3. Header chip: Connecting / **Live** / Reconnecting / Offline.
4. On `session.created` / `session.updated`:
   - Upsert session in list by `id`
   - Update `itemCount`, `status`, `lastSyncedAt`, URL/title
   - Sort by `lastSyncedAt` desc
   - Pulse highlight on changed row
   - If detail open for that `id`, replace Q&A from `session.questionsAnswers`
5. On `session.deleted`: remove row; close detail if same id.
6. `status === "recording"` → green “Live recording” pill.

No ellipsis truncation on URL / title / answers (existing rule).

================================================================================
ACCEPTANCE / DEBUG
================================================================================

1. Open Super Admin Q&A → chip becomes **Live** (must see `ready` event).
2. DevTools → Network → `stream` → type EventStream / pending, status 200.
3. Extension on Apply Page → type a field → list/detail updates < 1s without refresh.
4. If Network shows 401 on `stream`, auth is wrong — use fetch+Bearer or ticket.
5. If `stream` is missing entirely, the live client was never mounted — fix that first.
6. Backend logs `SSE client connected` when Live; if sync happens with
   `0 SSE subscribers`, the FE is not connected.

================================================================================
OUT OF SCOPE
================================================================================

- Do not change the Chrome extension for this bug.
- Do not poll every N seconds as the main solution (reconnect SSE instead).
- Do not proxy SSE through a buffering serverless function.
