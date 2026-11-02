# Frontend Cursor Prompt — Remove Application Q&A module

Paste this into Cursor on the **Devora21 frontend** repo.

---

## Goal

Remove the **Application Q&A** product surface from Super Admin (and any user-facing entry points). Keep **Application Captures**, Profile management, Resume analytics, and Security.

The card to remove (from the modules grid):

- **MODULE 03 — Application Q&A**
- Copy: *“Three-panel review: profile → date → Apply Page session → questions & answers from the Chrome extension.”*
- Action: **OPEN →**

Do **not** delete Application Captures (MODULE 04 in the screenshot).

---

## Exact work

1. **Modules / home grid**
   - Remove the Application Q&A card entirely.
   - Renumber remaining modules so labels stay sequential (e.g. Profile = 01, Resume analytics = 02, Application Captures = 03, Security stays consistent with existing SECURITY section numbering).
   - Do not leave an empty grid cell or placeholder.

2. **Navigation**
   - Remove Super Admin (and any other) nav links labeled **Application Q&A**, **Apply Q&A**, **QA sessions**, etc.
   - Remove sidebar items, breadcrumbs, and “related” links that point at Q&A.

3. **Routes**
   - Remove frontend routes for Application Q&A list/detail/live SSE pages (whatever paths you use, e.g. `/admin/application-qa`, `/super-admin/application-qa`, etc.).
   - Redirect old Q&A URLs to Super Admin home or Application Captures (prefer Captures if that replaced the workflow).

4. **Dead code**
   - Remove Q&A-only pages, components, hooks, SSE clients, and API wrappers that only served Application Q&A.
   - Do **not** remove Application Captures gallery code or its `/admin/application-captures` client.

5. **Copy / docs in UI**
   - Strip in-app help text that says “next to Application Q&A” or describes the Chrome extension as feeding Q&A sessions.
   - If Captures help text mentioned Q&A, point it at **Application Captures** only.

6. **Out of scope**
   - Do **not** change backend APIs in this task.
   - Do **not** remove the Capture Chrome extension integration.
   - Do **not** remove Profile / Resume analytics / Security modules.

---

## Acceptance

- [ ] MODULE 03 Application Q&A card gone from the modules grid
- [ ] No Super Admin nav entry for Application Q&A
- [ ] Old Q&A routes redirect or 404 cleanly (no broken menu)
- [ ] Application Captures still opens and works
- [ ] Module numbers / SECURITY footer still look intentional (no skipped hole labeled “03” for Q&A)

---

## Design

Match the existing Super Admin design system. After removal, the grid should look balanced (same card style for remaining modules).
