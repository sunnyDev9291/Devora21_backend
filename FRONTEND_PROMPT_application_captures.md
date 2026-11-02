# Frontend Cursor Prompt — Application Captures (Super Admin gallery)

Paste this into Cursor on the **Devora21 frontend** repo.

---

## Product context (already working on backend + extension)

Captures are created by the **Chrome extension** automatically:

1. User clicks **Submit** on an apply page (extension intercepts).
2. Extension scrolls top → bottom with **10% overlap** and **500ms** settle delay.
3. Slices are grayscale JPEG-compressed and **auto-uploaded** to the backend.
4. Images are stored on **Backblaze B2**; DB rows are `ApplicationCaptureSession` + `ApplicationCaptureImage`.
5. Extension then fires the site’s **native** submit (and re-arms if validation fails).

**Backend upload is already live** (`POST /extension/application-captures` → `201`).  
Frontend only needs a **Super Admin gallery** to browse everyone’s captures.

Do **not** build upload UI or extension settings in the web app.

---

## Goal

Build a **Super Admin → Application Captures** gallery:

- List capture sessions **across all users**
- Filter by owner / search
- Open a session → show grayscale slices top → bottom
- Lightbox on click
- Delete a session
- Manual refresh only (no WebSockets / SSE / polling)

Optional: a user-scoped “my captures” page via `/application-captures` is fine later; **priority is Super Admin**.

---

## Super Admin APIs (shipped)

Auth: Super Admin session (same as `/admin/application-qa/*`).  
Base: `/admin/application-captures`

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/application-captures/owners` | Users who have captures |
| `GET` | `/admin/application-captures?page=1&limit=25&userId=&q=&date=&timezone=` | Paginated sessions (all users; optional calendar day) |
| `GET` | `/admin/application-captures/:id` | One session + **all** ordered `images[]` |
| `DELETE` | `/admin/application-captures/:id` | Soft-delete (`status: "deleted"`) |

### Owners response

```json
{
  "owners": [
    {
      "userId": "uuid",
      "email": "user@example.com",
      "name": "Ada Lovelace",
      "captureCount": 12,
      "lastCapturedAt": "ISO-8601"
    }
  ]
}
```

### List response

```json
{
  "sessions": [
    {
      "id": "uuid",
      "userId": "uuid",
      "clientCaptureId": "string",
      "tabUrl": "https://…",
      "pageTitle": "string | null",
      "status": "uploaded",
      "sliceCount": 5,
      "capturedAt": "ISO-8601",
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "owner": {
        "userId": "uuid",
        "email": "user@example.com",
        "name": "Ada Lovelace"
      },
      "images": [
        {
          "id": "uuid",
          "sortOrder": 0,
          "imageUrl": "https://…signed…",
          "width": 1280,
          "height": 720,
          "byteSize": 120000,
          "createdAt": "ISO-8601"
        }
      ]
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 42,
  "totalPages": 2
}
```

Notes:

- List includes **first image only** as a thumbnail; detail returns all slices.
- `images` ordered by `sortOrder` ascending (0 = top of page).
- `imageUrl` may be a **signed B2 URL** that expires — on 403, re-fetch session detail.
- Query `userId` filters to one owner; `q` searches URL / title / clientCaptureId / owner email / name.

### Detail response

```json
{
  "session": {
    "id": "uuid",
    "userId": "uuid",
    "tabUrl": "https://…",
    "pageTitle": "…",
    "status": "uploaded",
    "sliceCount": 5,
    "capturedAt": "ISO-8601",
    "owner": { "userId": "uuid", "email": "…", "name": "…" },
    "images": [
      { "id": "uuid", "sortOrder": 0, "imageUrl": "https://…", "width": 1280, "height": 800 }
    ]
  }
}
```

### User-scoped APIs (optional / non-admin)

| Method | Path | Scope |
|--------|------|--------|
| `GET` | `/application-captures` | Own captures only |
| `GET` | `/application-captures/:id` | Own only |
| `DELETE` | `/application-captures/:id` | Own only |

---

## UX / IA (Super Admin)

1. Nav under Super Admin: **Application Captures**.  
   Suggested route: `/super-admin/application-captures`.
2. **List page**
   - Owner filter (from `/owners`) + search `q` + **Refresh**.
   - Card/row: owner email/name, page title, hostname from `tabUrl`, `capturedAt`, `sliceCount`, status badge.
   - Thumbnail from `images[0].imageUrl`.
   - Click → detail.
   - Pagination.
3. **Detail page / drawer**
   - Owner, title, external link to `tabUrl`, timestamp, slice count.
   - Vertical stack of images in `sortOrder` order (top → bottom).
   - Click → lightbox; optional next/prev between slices.
   - Delete with confirm → `DELETE` → back to list.
4. **Empty state**  
   “No captures yet. When a user enables the Devora21 Capture extension and clicks Submit on an apply page, screenshots upload here automatically.”

---

## Design

- Follow the **existing Super Admin design system** (same card / gallery patterns as other Super Admin modules).
- Screenshots are the focus; keep chrome minimal.
- Avoid generic purple gradients / cream+terracotta AI clichés.

---

## Technical requirements

- Reuse existing admin API client / Super Admin auth wrappers.
- Types: `ApplicationCaptureSession`, `ApplicationCaptureImage`, `ApplicationCaptureOwner`.
- Handle expired signed image URLs (placeholder + refetch detail).
- Do **not** implement:
  - Extension upload from the web app
  - Live Q&A / DOM streams
  - Real-time polling / SSE for this gallery
  - Editing or reordering screenshots

---

## Acceptance checklist

- [ ] Super Admin can list captures for **all users**
- [ ] Filter by owner + search works
- [ ] Detail shows all slices top → bottom
- [ ] Lightbox works
- [ ] Delete works
- [ ] Refresh is manual only
- [ ] Empty state documents extension Submit → auto-upload flow
- [ ] Placed in Super Admin nav (Application Captures)

---

## Out of scope

- Changing the Chrome extension
- WebSockets / SSE
- Creating captures from the web UI
