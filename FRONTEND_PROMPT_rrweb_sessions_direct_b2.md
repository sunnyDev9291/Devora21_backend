# Cursor frontend prompt — fast events download via signed B2 URL

Paste into the **frontend** Cursor chat (Super Admin rrweb replay).

## Goal

Download session events **directly from Backblaze** using the signed `eventsUrl` (one hop). Fall back to the API proxy only if B2 CORS fails.

Backend now:
- Signs `eventsUrl` as an **S3 presigned GET**
- Applies bucket **CORS** for configured frontend origins on API boot
- Sets `replayHints.preferDirectEventsUrl: true`
- Keeps `eventsPath` as fallback: `/admin/rrweb-sessions/:id/events`

## Required load order

```ts
async function loadEventsBytes(detail: {
  id: string
  eventsUrl: string | null
  eventsPath: string | null
  eventsEncoding: "gzip" | "json" | null
  replayHints?: { preferDirectEventsUrl?: boolean }
}, apiBase: string, token: string, onProgress?: (msg: string) => void): Promise<Uint8Array> {
  const preferDirect = detail.replayHints?.preferDirectEventsUrl !== false;

  // 1) Direct B2 (fast path)
  if (preferDirect && detail.eventsUrl) {
    try {
      onProgress?.("Downloading events… (direct)");
      // IMPORTANT: do NOT send Authorization: Bearer — auth is inside the signed URL.
      const res = await fetch(detail.eventsUrl, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
      });
      if (!res.ok) throw new Error(`b2 ${res.status}`);
      return await readBodyWithProgress(res, onProgress);
    } catch (err) {
      // CORS / network → fall through to API proxy
      console.warn("[rrweb] direct B2 failed, using API proxy", err);
      onProgress?.("Downloading events… (proxy)");
    }
  }

  // 2) Same-origin API proxy (reliable fallback)
  if (!detail.eventsPath) throw new Error("No eventsPath");
  const res = await fetch(`${apiBase}${detail.eventsPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`events ${res.status}`);
  return await readBodyWithProgress(res, onProgress);
}
```

## Critical rules

1. **Prefer `detail.eventsUrl`** when present and `preferDirectEventsUrl` is not false.
2. **Never** attach Super Admin `Authorization` header to the B2 request (breaks CORS / signature).
3. On any direct failure (`TypeError: Failed to fetch`, CORS, non-OK) → **retry once** via `eventsPath` with Bearer.
4. Keep load stages: download → decompressing → parsing → preparing → loading player → ready.
5. Still use `X-Events-Encoding` from proxy response when using proxy; for direct B2, detect gzip via magic bytes `1f 8b` or `eventsEncoding` from detail.
6. TOP-first player; full color; abort in-flight fetch on session switch.

## Progress helper (same as before)

Stream `res.body.getReader()`, show `Downloading events… received / total (%)` when `Content-Length` exists.

## Quick check

- [ ] Network tab: first attempt is B2/S3 host (not your API) for events
- [ ] 6 MB session downloads faster than via API proxy (when CORS works)
- [ ] If B2 CORS blocked, automatic fallback to `/admin/rrweb-sessions/:id/events` still plays
- [ ] Stages still show download / decompress / parse correctly
- [ ] No `Authorization` header on the B2 request
