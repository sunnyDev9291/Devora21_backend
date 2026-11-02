# Cursor frontend prompt — fix stuck “Waiting for first sync…” after tab close

Paste into the **frontend** Cursor chat (Super Admin rrweb player).

## What happened

1. Tab open → session `status: "recording"`, `replayable: false` → UI shows **Waiting for first sync…** (OK).
2. Tab close → Recording badge clears (`status: "uploaded"`) but player **still** says Waiting for first sync….

Cause: FE treats all `!replayable` the same. After finish, if there are still no events on B2 (`replayable` stays false), or FE never re-reads detail after SSE, the waiting copy never updates.

Extension 4.2.7 also flushes harder on tab close so more sessions become `replayable: true`. FE must still show correct copy for both cases.

## Required status copy

| `status` | `replayable` | Player status |
|----------|--------------|---------------|
| `recording` | `false` | `Waiting for first sync…` |
| `recording` | `true` | Enable Play / load events (partial OK) |
| `uploaded` | `true` | Load / play (not “waiting”) |
| `uploaded` | `false` | **`No events recorded for this session`** (not “Waiting for first sync…”) |
| `failed` | — | `Recording failed` |

Never show **Waiting for first sync…** when `status === "uploaded"` or `status === "failed"`.

## Required SSE / detail refresh

When the open session receives SSE `session.updated`:

1. Replace local session object with the payload (or re-fetch detail).
2. Recompute player status from new `status` + `replayable`.
3. If `replayable` flipped to `true` → start load pipeline (or enable Play).
4. If `status` flipped to `uploaded` and still `!replayable` → show **No events recorded…**, clear spinner.

Do not keep a stale `loadPhase: 'waiting'` from when the session was still recording.

## Quick check

- [ ] Live recording, no events yet → Waiting for first sync…
- [ ] Tab close, events uploaded → Recording badge gone, player loads / Ready (not waiting)
- [ ] Tab close, zero events → badge gone, message **No events recorded…** (not waiting)
- [ ] SSE update refreshes open detail without full page reload
