# Cursor frontend prompt — fix “outside selected day” banner + “Replay not available yet”

Paste into the **frontend** Cursor chat (Super Admin rrweb sessions).

## Bugs

1. Yellow banner: `Live update for … is outside the selected day.`  
   Fires even when the date picker is that day and the session is already in the list (e.g. `10/27/2026` + `America/New_York`, session `8:00 AM EDT`).

2. Player: `Replay not available yet.`  
   Shown when `session.replayable === false` (no events on B2 yet). Must recover when SSE/detail flips `replayable` to true — not stay stuck.

Backend day filter uses zoned half-open interval `[start, end)` via `startedAt` + selected IANA timezone (same idea as `zonedDayBoundsUtc`). Extension now flushes earlier so `replayable` becomes true sooner after recording starts.

---

## Fix 1 — SSE day check (stop false “outside selected day”)

When handling SSE `session.created` / `session.updated`:

1. Use the **selected** `date` (`YYYY-MM-DD`) and **selected** `timezone` (e.g. `America/New_York`) — **never** the browser’s local timezone alone.
2. Decide membership with **`session.startedAt`** (ISO UTC), **not** `updatedAt`, **not** `Date.now()`.
3. Compare with a proper zoned day bounds helper (match backend):

```ts
function zonedDayBoundsUtc(dateYmd: string, timeZone: string): { start: Date; end: Date } {
  // Wall midnight → UTC for dateYmd and next calendar day in timeZone
  // (use Temporal or a small Intl offset two-pass, same as backend zonedDayBoundsUtc)
}

function isStartedAtOnSelectedDay(startedAtIso: string, dateYmd: string, timeZone: string) {
  const t = new Date(startedAtIso).getTime();
  const { start, end } = zonedDayBoundsUtc(dateYmd, timeZone);
  return t >= start.getTime() && t < end.getTime();
}
```

4. If **inside** the selected day → upsert into the list silently. **Do not** show the yellow banner.
5. If **outside** the selected day → **silently ignore** (do not toast/banner on every live flush). Optional: one muted log. Only if the user has that session open in the detail pane, show a calm note: “This session belongs to another day” with a button to jump the date picker to that day — not a repeated error banner.
6. Never show the banner for sessions already visible in the current filtered list.

---

## Fix 2 — “Replay not available yet”

1. Show that message **only when** `replayable === false` (or events fetch 404 / empty).
2. While `status === "recording"` && `!replayable`: copy like  
   `Waiting for first sync…` (not a hard error). Keep Play disabled.
3. On SSE `session.updated` for the open session: if `replayable` becomes `true`, **auto-enable Play** and optionally auto-load events (or prompt “Ready — Play”).
4. Do **not** keep showing “Replay not available yet” after `replayable` is true.
5. Prefer `GET …/events` via `eventsPath`; never B2 `eventsUrl` in the browser.
6. Refresh detail metadata on SSE for the open id so `eventCount` / `replayable` stay current.

---

## Quick check

- [ ] Select today in ET; live recording on that day → **no** yellow “outside selected day” banner on each sync
- [ ] Session from another day arrives on SSE → no spam banner; list unchanged
- [ ] New recording: player says waiting until first sync, then Play works without full page reload
- [ ] Session already in list is never labeled “outside selected day”
