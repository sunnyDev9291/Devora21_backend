# Devora21 Application Q&A Chrome Extension

Captures job-application questions and answers **per browser tab**, syncs them to the Devora21 backend, and surfaces them in the Super Admin dashboard.

Extension icons live in `icons/` (`icon16.png`, `icon48.png`, `icon128.png`, plus `logo.png` master).

## Install (unpacked)

1. Create a Devora21 **API key** (`dv21_…`) for the extension owner in the web app.
2. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select this `chrome-extension/` folder.
3. Open **Options**:
   - Accept consent
   - Set API base URL (e.g. `http://31.44.7.64:5000` or your HTTPS API)
   - Paste API key
   - Leave **host restrict list empty** to record on **any** apply page (recommended)
   - Or optionally list domains if you want to limit capture
   - Enable recording
4. Click the extension icon — the UI opens as a **Chrome side panel (sidebar)** and
   stays open while you browse. Enable recording, then open a job application.
   Answers buffer locally immediately; they sync only after **Apply Page** detection.

## UI

- **Side panel only** (no popup): toolbar icon opens `sidepanel.html` and keeps it
  docked beside the page. Status auto-refreshes as you switch tabs.
- Chrome cannot force the sidebar open without a click; after install, click the
  icon once (or pin the extension) to show it.

## Behavior

- **Buffer-then-flush:** with recording on, answers are saved in a **local tab buffer**
  immediately (multi-step dialogs). Nothing is uploaded yet.
- **Apply Page detection:** page/iframe must contain **both**
  1. an **email** input, and
  2. a **resume/CV upload** (`input[type=file]` for resume/CV/PDF/DOC)
  Detection scans **all iframes + shadow DOM**.
- When both are seen → tab is latched as Apply Page → **buffer is synced** to the backend
  and further answers keep syncing (even if those fields disappear later).
- If never detected → buffer is **discarded** (not sent).
- Same tab → **different host** clears buffer + classification.
- Passwords / payment / OTP-like fields are skipped (client + server)
- **DOM input events** (v1.5+): no question↔answer matching. Each interaction
  stores value + element metadata (`elementKey`, tag, type, id, name, class,
  cssSelector, attributes, eventType, timestamp). Unchanged values are skipped.
  Super Admin shows a chronological event list (`FRONTEND_PROMPT_application_qa_dom_events.md`).
- Badge: event count while buffering / syncing / `…` waiting / `OFF`

## Backend endpoints used

- `GET /extension/me`
- `POST /extension/application-qa/sync`
- `GET|PATCH|DELETE /extension/application-qa/sessions…`

Super Admin UI uses `/admin/application-qa/*` (see frontend prompt).
