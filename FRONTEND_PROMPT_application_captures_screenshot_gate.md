# Cursor frontend prompt — Application Captures (screenshot gate + live SSE)

Paste into the **frontend** Cursor chat (Super Admin dashboard).

## Product (backend + extension shipped)

Chrome extension intercepts clicks on elements whose label contains **Submit**, **Apply**, or **Send** (case-insensitive).

Dialog: **“Did you take the screenshot?”**

| Button | Behavior |
|--------|----------|
| **Upload & Continue** | Upload JPEG/PNG + URL + profile + timestamp → only then fire the original click once |
| **Cancel** | Close dialog; block the click |
| **This is not an Apply Page** | Close dialog; fire original click; **no** capture record |

Backend stores `ApplicationCaptureSession` + `ApplicationCaptureImage` on B2 and broadcasts via **SSE** (not Socket.IO).

## Goal

Three-panel Super Admin workspace with **instant** updates when a screenshot uploads.

```
┌─────────────────────────────────────────────────────────────┐
│  TOP: Date (YYYY-MM-DD) + timezone (default America/New_York)│
├──────────────┬────────────────────┬─────────────────────────┤
│ LEFT         │ MIDDLE             │ RIGHT                   │
│ Profiles     │ Application URLs   │ Screenshots + lightbox  │
│ (owners)     │ for profile+date   │ for selected session    │
└──────────────┴────────────────────┴─────────────────────────┘
```

## APIs (already live)

Auth: Super Admin (same as other `/admin/*`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/application-captures/owners` | Profiles with captures |
| `GET` | `/admin/application-captures?userId=&date=&timezone=&q=&page=&limit=` | Sessions for day |
| `GET` | `/admin/application-captures/:id` | Session + `images[]` (ordered) |
| `DELETE` | `/admin/application-captures/:id` | Soft-delete session |
| `DELETE` | `/admin/application-captures/:id/images/:imageId` | Delete one image |
| `POST` | `/admin/application-captures/:id/images/:imageId/review` | Mark reviewed (optional) |
| `POST` | `/admin/application-captures/stream-ticket` | SSE ticket |
| `GET` | `/admin/application-captures/stream?ticket=` | SSE stream |

### Live SSE

1. `POST /admin/application-captures/stream-ticket` → `{ streamPath }`
2. `EventSource(streamPath)` (cookie/ticket auth as with other admin streams)
3. Events include capture created/updated/deleted (and image review/delete)
4. On create/update: upsert owner badge + middle list row; if detail open for that id, refresh images
5. Auto-reconnect with backoff if EventSource drops; optional light poll only while disconnected

Do **not** require a full page refresh to see new screenshots.

## UI rules

### Left — Profiles
- From `owners`: name/email, capture count, last captured
- Select profile → load middle for current date

### Middle — URLs / sessions
- Rows: primary URL (or host), page title, time, slice count
- Filters: date + optional URL search `q`
- Select → load right panel detail

### Right — Screenshots
- Show image thumbnails (signed `imageUrl` from detail)
- Click → **fullscreen / lightbox** (prev/next, Esc close)
- Delete session or single image with confirm
- Empty state: “No screenshot yet for this session”

### Date filter
- Changing date reloads middle list for the selected profile
- New SSE uploads for **other** days: do not spam errors; optionally ignore or soft-note

## Security / UX

- Treat screenshots as sensitive PII
- Never upload from the web app — extension only
- Handle broken image URLs gracefully

## Quick check

- [ ] Extension Upload & Continue → new row appears in Super Admin without refresh
- [ ] Lightbox opens full-size image
- [ ] Date filter + timezone work
- [ ] SSE reconnects after network blip
- [ ] “Not an Apply Page” does not create a row
- [ ] Cancel does not submit the job site action
