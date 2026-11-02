# Cursor frontend prompt — duration match, clear Recording badge fast, live partial replay

Paste into the **frontend** Cursor chat (Super Admin rrweb sessions).

## Problems

1. **List shows 47s, player ends ~36s** — list used wall-clock (`endedAt − startedAt`); player uses rrweb event timestamps. Idle/hidden gaps and late first snapshot make wall clock longer. Backend now stores **event-timeline `durationMs`** when events exist.
2. **Recording badge lingers after tab close** — SSE `session.updated` with `status: "uploaded"` not applied immediately to the list/detail.
3. **“Nothing / full screen only after close”** — FE waited for finish instead of playing **partial** events while `status === "recording"` and `replayable === true`.

## Fix 1 — Duration display

- List / detail duration: use API `durationMs` (now event-based after sync/complete).
- Player scrubber end: from loaded events (`last.timestamp − first.timestamp`), same idea.
- With **skip inactive** ON: *playback* feels shorter than `durationMs` (gaps skipped) — that is OK. Do **not** change list duration to “play time with skips.”
- Optional subtitle if useful: `36s replay · skip idle on` — do not invent a second conflicting number.

Do not compute list duration as `Date.now() − startedAt` on the client for finished rows.

## Fix 2 — Recording badge clears immediately

On SSE `session.created` / `session.updated` / `session.deleted`:

1. Upsert/remove the row **synchronously** from the event payload (do not wait for a full list refetch).
2. Show **Recording** badge **only if** `session.status === "recording"`.
3. When `status` becomes `"uploaded"` | `"failed"` | `"deleted"` → remove badge in the same tick.
4. If detail is open for that id → patch local detail state the same way.
5. Avoid caching `isLive` / `isRecording` separately from `status`.

## Fix 3 — Don’t wait for tab close to watch

While `status === "recording"` && `replayable === true`:

- Enable Play / auto-load partial events (TOP frame).
- Subtitle: `Partial replay — more events may appear; refresh to update`.
- On each SSE update with higher `eventCount`, offer refresh or soft-reload events (don’t remount mid-scrub unless user clicks Refresh).

While `recording` && `!replayable`: `Waiting for first sync…` only.

When `uploaded` && `replayable`: full replay, no waiting copy.

When `uploaded` && `!replayable`: `No events recorded for this session`.

## Quick check

- [ ] Finished session: list duration ≈ player timeline end (within ~1s)
- [ ] skip inactive ON: play feels faster but listed duration unchanged
- [ ] Tab close → Recording badge gone on next SSE (no manual refresh)
- [ ] During live recording after first sync → can play partial without closing the tab
