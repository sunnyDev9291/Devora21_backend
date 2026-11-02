# Cursor frontend prompt — show real replay load stages (download / gunzip / parse / mount)

Paste into the **frontend** Cursor chat (Super Admin rrweb TV / player).

## Goal

Replace a single stuck label like **“Downloading events…”** with **accurate stage text** so users see what is actually happening:

1. Waiting / checking replayable  
2. Downloading events  
3. Decompressing (gunzip)  
4. Parsing JSON  
5. Preparing player (pick TOP frame)  
6. Ready / Playing  

Backend already streams `GET /admin/rrweb-sessions/:id/events` with:
- `X-Events-Encoding: gzip | json`
- `Content-Length` when known (use for download %)

## Required UI states

Show **one primary status line** under/inside the player (monospace OK). Update it as each stage starts. Never leave “Downloading events…” during gunzip/parse.

| Stage | Status text (examples) | When |
|-------|------------------------|------|
| `idle` | — or “Select a session” | No session |
| `waiting` | `Waiting for first sync…` | `replayable === false` |
| `download` | `Downloading events…` or `Downloading events… 1.2 / 3.4 MB (35%)` | `fetch` in progress |
| `gunzip` | `Decompressing…` | After bytes received and encoding is gzip |
| `parse` | `Parsing events…` | During `JSON.parse` |
| `prepare` | `Preparing player…` | Pick TOP frame / build frame tabs |
| `mount` | `Loading player…` | Constructing `rrweb-player` |
| `ready` | Clear status (or brief “Ready”) | Player mounted; Play enabled |
| `error` | Short error + Retry | Network / gunzip / parse / empty frames |

Optional secondary line: session id / frame label (`TOP · mail.google.com`).

## Implementation rules

1. **Do not** keep `status = "Downloading events…"` for the whole pipeline.
2. Use a single state machine, e.g. `loadPhase: 'waiting' | 'download' | 'gunzip' | 'parse' | 'prepare' | 'mount' | 'ready' | 'error'`.
3. Download via `eventsPath` only (same-origin). Read `X-Events-Encoding` and `Content-Length`.
4. Progress during download (when `Content-Length` present):

```ts
const total = Number(res.headers.get("Content-Length") || 0);
const reader = res.body!.getReader();
const chunks: Uint8Array[] = [];
let received = 0;
setPhase("download");
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value!);
  received += value!.byteLength;
  if (total > 0) {
    setStatus(`Downloading events… ${fmtBytes(received)} / ${fmtBytes(total)} (${Math.round((100 * received) / total)}%)`);
  } else {
    setStatus(`Downloading events… ${fmtBytes(received)}`);
  }
}
const buf = concat(chunks);
```

5. If encoding is gzip (header or magic `1f 8b`):
   - `setPhase("gunzip")` → `setStatus("Decompressing…")`
   - Then `DecompressionStream("gzip")` (or library)
6. `setPhase("parse")` → `setStatus("Parsing events…")` → `JSON.parse`
7. `setPhase("prepare")` → pick TOP frame, build tab list from `frames[]` (do not merge frames)
8. `setPhase("mount")` → `setStatus("Loading player…")` → create player with TOP events only, full color, Play/Pause visible
9. `setPhase("ready")` → clear busy status
10. On session switch / unmount: **abort** in-flight fetch (`AbortController`) so stages don’t overlap.
11. On SSE `replayable` false → true for open session: run this pipeline (or enable Play that runs it). Don’t stay on a stale “Downloading…” forever.

## Error copy

- Network fail: `Download failed — Retry`
- Gunzip fail: `Decompress failed — Retry`
- Parse fail: `Invalid events payload — Retry`
- Empty / no TOP frame: `No replay events for this frame`

## Quick check

- [ ] Large session: status moves download → decompressing → parsing → preparing → loading player → ready  
- [ ] Never stuck on “Downloading events…” while CPU is gunzipping/parsing  
- [ ] When `Content-Length` exists, % or bytes progress shows during download  
- [ ] Gzip and plain JSON both show correct mid-stages  
- [ ] Switching sessions aborts previous download and resets stage text  
- [ ] `replayable === false` shows waiting, not download  
