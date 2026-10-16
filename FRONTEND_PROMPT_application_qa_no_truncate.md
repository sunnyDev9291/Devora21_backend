# Frontend Cursor Prompt — Fix Super Admin Application Q&A table truncation

Copy everything below to the **frontend** agent (this UI is not in the backend repo).

================================================================================
BUG
================================================================================

On Super Admin → Application Q&A → sessions table, long cells are cut with
ellipsis (`…`), e.g.:

  TAB URL:   `https://jobs.ashbyhq.com/Scale%20Army%20Careers/d899b7d...`
  UPDATED:   `2026/10/15 Thu 3:3...`

Super Admins cannot see the full URL or full timestamp. Same risk for PAGE TITLE.

================================================================================
FIX
================================================================================

In the Application Q&A sessions list (and detail if similar):

1) Remove `truncate` / `text-overflow: ellipsis` / `whitespace-nowrap` clamps on:
   - tab URL
   - page title
   - updated / lastSyncedAt

2) Show full content:
   - URL: complete `tabUrl` as a link; allow wrap (`break-all` / `overflow-wrap: anywhere`)
   - Title: wrap fully
   - Datetime: full formatted string (include minutes/seconds), never mid-string clip

3) If the table is wide, wrap the table in a horizontal scroll container instead
   of truncating cell text.

4) Detail page Q&A answers must also wrap fully (no line-clamp ellipsis).

================================================================================
ACCEPTANCE
================================================================================

- Long Ashby/Greenhouse/Workday URLs are fully readable in the list
- Updated column shows complete datetime
- No `…` truncation on URL / title / timestamp / Q&A answer cells
