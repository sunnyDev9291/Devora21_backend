# Cursor frontend prompt — missing Play / Pause on rrweb TV

Paste into the **frontend** Cursor chat (Super Admin rrweb replay UI).

## Bug

Sometimes the session player control bar shows the scrubber, timestamps (`00:00` / duration), speed chips (`1X` `2X` `4X`), and “DIRECT PLAY”, but **no Play / Pause (or Stop) button** in the left control slot. It is intermittent (often after opening a session, switching TOP ↔ IFRAME, or live/partial replay).

**Backend is fine** — events/metadata APIs do not render controls. This is a frontend player-chrome bug.

## Required fix

1. Find the custom rrweb player controls (not only `rrweb-player` defaults).
2. **Always render** a Play / Pause toggle whenever a player instance exists and has a usable `events` array (including iframe frames and “DIRECT PLAY”).
3. Do **not** hide Play behind narrow conditions such as:
   - `status === "uploaded"` only
   - top frame only
   - `!liveReplay` / `!recording`
   - `ready` flag that never flips on iframe remount
4. On frame tab change (TOP / IFRAME): remount player **and** remount the same control chrome so Play is present after load.
5. If using `showController: false` on `rrweb-player`, the custom bar must include Play/Pause; if using built-in controller, don’t strip its play button with CSS.
6. Check CSS: the left slot must not clip the button (`overflow`, zero width, `opacity: 0`, `color` same as background).

## Behavior

| State | Play / Pause |
|-------|----------------|
| Events loaded, player mounted | **Visible** — Play when paused, Pause when playing |
| Loading events | Optional disabled Play or spinner — never an empty hole |
| No events / not replayable | Disabled or hidden with tooltip — not a blank gap next to scrubber |

Wire the button to the same player API you already use for scrubber / speed (`play()`, `pause()`, or equivalent).

## Quick check

- [ ] Open finished session → Play visible
- [ ] Switch IFRAME tabs → Play still visible after each load
- [ ] Live/partial (“Recording”) + DIRECT PLAY → Play visible
- [ ] Fullscreen TV → Play / Pause still present
- [ ] Click Play starts replay; Pause stops without remounting
