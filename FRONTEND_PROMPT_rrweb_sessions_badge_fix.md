# Cursor frontend prompt — clear stuck Recording badge + remove unchecked badge

Paste into the **frontend** Cursor chat.

## Bug

After a tab closes, Super Admin still shows:

1. Pink **Recording** badge on the session list + detail (and “Partial replay…” copy).
2. Red **unchecked count** pill on the Profiles column (e.g. `14`).

Backend + extension now finalize `status → uploaded` and always return `uncheckedCount: 0`. Frontend must stop rendering those badges incorrectly.

## Required UI changes

### 1. Recording badge (list + detail)

Show **Recording** / partial-replay UI **only when** `session.status === "recording"`.

- If `status === "uploaded"` | `failed` | `deleted`: **never** show Recording badge or “Partial replay — more events may appear…”.
- On SSE `session.updated`, upsert the row and recompute badges from the new `status` (do not keep a local “isLive” flag).
- Prefer `status` over `replayHints.liveReplay` if they ever disagree.

### 2. Remove unchecked / unreviewed badge

On the Profiles (owners) list:

- **Remove** the red circular count badge next to names.
- Do not render `owner.uncheckedCount` (API always sends `0` now).
- Optional: stop calling review solely to decrement that badge (review may stay for other analytics; badge UI goes away).

### 3. Filters

`RECORDING` chip = `status === "recording"` only.  
`FINISHED` = `status === "uploaded"`.

## Quick check

- [ ] Finished session: no Recording pill in list or detail
- [ ] Finished session: no “Partial replay…” line
- [ ] Profiles: no red count badge
- [ ] Live tab still open: Recording badge still shows until tab closes / SSE flips to uploaded
