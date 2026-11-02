# Cursor frontend prompt — rrweb TV full color (no grayscale)

Paste into the **frontend** Cursor chat.

## Goal

Super Admin session replay **TV must be full color**. Remove any grayscale filter on the player.

## Why

Backend now sends `replayHints.grayscaleOk: false`. Color vs gray is display-only and does not change storage size — keep the real page colors for review.

## Required changes

1. Find the rrweb player container (session detail / fullscreen TV).
2. **Remove** any of:
   - `el.style.filter = "grayscale(1)"`
   - CSS like `.rrweb-player { filter: grayscale(1); }`
   - Conditional grayscale based on `replayHints.grayscaleOk`
3. If you branch on `grayscaleOk`, treat `false` / missing as **full color**.
4. Fullscreen mode must also stay in color (same rule).

## Quick check

- [ ] List → open session → player shows original page colors
- [ ] Fullscreen TV is not gray
- [ ] No `filter: grayscale` left on player wrappers
