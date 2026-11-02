# Cursor frontend prompt — rrweb TOP-first + lazy IFRAME tabs

Paste into the **frontend** Cursor chat (Super Admin session replay).

## Goal

Fast, smooth replay for multi-frame sessions:

1. **Play TOP frame first** (immediate start).
2. **List all frames as tabs** (TOP + each IFRAME).
3. **Lazy-load** an IFRAME’s events only when that tab is selected.
4. **One frame at a time** — never merge all frames into one `rrweb-player` timeline.
5. **Full color** — no `filter: grayscale(1)`.

Backend already returns `replayHints.preferTopFrame`, `lazyIframeFrames`, `playOneFrameAtATime`, `skipInactive`, `grayscaleOk: false`.

## APIs (unchanged)

- Detail: `GET /admin/rrweb-sessions/:id`
- Events: `GET /admin/rrweb-sessions/:id/events` (prefer `detail.eventsPath`; auth required)
- Do **not** `fetch(eventsUrl)` (B2 CORS).
- Do **not** use `?includeEvents=1` for normal UI.

Events JSON shape:

```ts
{
  version: 1,
  frames: Array<{
    frameKey: string
    href?: string
    isTop?: boolean
    events: any[]
  }>
}
```

## Required UX

### On open session

1. Show detail shell immediately (title, status, duration, Play).
2. Fetch events via `eventsPath` once; keep the parsed `frames[]` in memory for this session.
3. Build tab strip from frames (do not remount until user picks a tab):
   - TOP: `isTop === true` OR `frameKey === "top"` OR first frame fallback
   - Label: `TOP · {hostname}` or `IFRAME · {hostname}` (from `href`, else frameKey)
4. Auto-select TOP and mount player with **only** `top.events`.
5. `skipInactive: true`, `autoPlay: false`, full color.
6. Always show Play / Pause when the player is mounted.

### On IFRAME tab click

1. Destroy or remount player for the selected frame only (`events: thatFrame.events`).
2. Do **not** re-download the whole gzip if frames are already in memory.
3. If that frame has 0 events, show empty state — do not fall back to merging other frames.
4. Keep Play / Pause visible after remount.

### Do not

- Concatenate all frames’ events into one player.
- Auto-play every iframe on open.
- Block first paint waiting for iframe tabs beyond building labels from the same payload.
- Apply grayscale.

## Helper sketch

```ts
function frameLabel(f: { frameKey: string; href?: string; isTop?: boolean }) {
  let host = f.frameKey;
  try {
    if (f.href) host = new URL(f.href).hostname;
  } catch { /* keep */ }
  const kind = f.isTop || f.frameKey === "top" ? "TOP" : "IFRAME";
  return `${kind} · ${host}`;
}

function pickTopFrame(frames: any[]) {
  return (
    frames.find((f) => f.isTop) ||
    frames.find((f) => f.frameKey === "top") ||
    frames[0]
  );
}

function mountFrame(el: HTMLElement, events: any[]) {
  el.innerHTML = "";
  el.style.filter = "";
  return new rrwebPlayer({
    target: el,
    props: {
      events,
      skipInactive: true,
      showController: true, // or custom bar with Play/Pause always visible
      autoPlay: false,
    },
  });
}
```

## Quick check

- [ ] Multi-frame session: TOP plays first without waiting on iframes
- [ ] Tabs show TOP + each IFRAME with hostname labels
- [ ] Clicking IFRAME remounts that frame only; TOP still works when switching back
- [ ] No merged timeline; no grayscale
- [ ] Play / Pause always present when player is ready
- [ ] Single-frame sessions: one TOP tab only
