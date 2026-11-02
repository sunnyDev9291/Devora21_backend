# Cursor frontend prompt — remove rrweb session replay (Super Admin)

Paste into the **frontend** Cursor chat.

## Goal

**Remove the entire rrweb / session replay product** from the Super Admin web app. Recording and replay are discontinued on backend + extension. Keep **Application Captures** (screenshot gate) as the apply monitoring UI.

## Remove

1. Any Super Admin nav / route for:
   - rrweb sessions
   - session replay / TV player
   - “Apply Attempts” DOM replay
   - routes like `/super-admin/rrweb-sessions` (or equivalent)
2. All client code that calls:
   - `GET/DELETE /admin/rrweb-sessions*`
   - `POST /admin/rrweb-sessions/stream-ticket`
   - `GET /admin/rrweb-sessions/stream`
   - `GET /admin/rrweb-sessions/:id/events`
3. rrweb-player dependency / imports / vendor bundles used only for this feature
4. Dead types, hooks, stores, and SSE clients dedicated to rrweb

## Keep

- **Application Captures** gallery (profiles / URLs / screenshots + SSE)
- All other Super Admin modules (resumes, Q&A if still present, etc.)

## UX

- Nav should no longer mention Recording / Replay / rrweb
- Deep links to removed pages → redirect to Application Captures or Super Admin home
- No broken menu items or 404s for old rrweb URLs

## Quick check

- [ ] No rrweb / session replay entry in Super Admin nav
- [ ] No network calls to `/admin/rrweb-sessions`
- [ ] Application Captures still works (list + lightbox + live SSE)
- [ ] Build succeeds without rrweb-player if it was only used here
