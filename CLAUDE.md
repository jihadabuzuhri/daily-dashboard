# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server with HMR
- `npm run build` — production build to `dist/`
- `npm run preview` — serve the built `dist/` locally

No test, lint, or typecheck scripts are configured.

## Architecture

A single-page "Daily Dashboard" (tasks + bookmarks) built as **vanilla JS on Vite** — no framework, no bundler config, no TypeScript. The entire app is three files:

- [index.html](index.html) — static markup with fixed IDs (`#todo-list`, `#link-form`, `#toast`, `#theme-toggle`, `#greeting`, etc.). `src/main.js` queries these by ID rather than rendering structure, so renaming an ID requires editing both files.
- [src/main.js](src/main.js) — all behavior. Organized as flat sections (Storage / State / DOM refs / Greeting / Theme / Toast / Todos / Links / Keyboard shortcuts / Initial render). Two parallel feature blocks (todos and links) follow the same shape: module-level array → `save*()` → `render*()` → CRUD functions → form submit listener.
- [src/style.css](src/style.css) — all styling. Theme system is CSS custom properties under `:root` and `[data-theme="light"]`; the JS toggle just flips `data-theme` on `<html>`.

Persistence is **a single JSON file** at `data/store.json`, served by a small Vite dev-server middleware in [vite.config.js](vite.config.js) that handles `GET/PUT /api/store`. The `store` object at the top of [src/main.js](src/main.js) exposes `load()`, `save()` (debounced 200ms), and a shared `state` object (`{ todos, archivedTodos, links, theme }`). Module-level arrays (`todos`, etc.) are *references* into `store.state` — mutations are visible to the serializer without copying. `store.load()` deliberately uses `splice(0, len, ...newItems)` to refill the arrays in place so those references stay valid. The middleware whitelists keys on PUT (unknown keys are dropped, theme is coerced to `'light'|'dark'`). A `beforeunload` handler flushes any pending debounced save via `fetch({ keepalive: true })`.

**Important constraint:** persistence works under `npm run dev` only — the middleware doesn't run during `npm run build`/`preview` or under a static host. In that mode, the app falls back to in-memory state (changes are lost on reload, with a console warning).

Rendering is **full-list re-render on every change** (`innerHTML = ''` then rebuild). Acceptable at this scale; don't introduce a diffing layer unless the list grows. Items carry a stable `id` (`Date.now() + Math.random()`) and CRUD functions look them up via `arr.find(x => x.id === id)`, so reordering doesn't invalidate handlers.

Drag-and-drop is wired by a single `setupDnd({ container, itemSelector, getList, axis, onChange })` helper in [src/main.js](src/main.js) used by all three lists (active todos, archive, links). Listeners live on the container so they survive full re-renders; the reorder mutates the backing array in place via `splice` and calls `onChange` to persist + re-render. Link tiles disable `draggable` while a search filter is active.

Inline editing uses `contentEditable` spans with `blur` → save and `Enter` → blur. Empty edits delete the item. Delete actions show an undo toast (4s) that re-splices the removed item back at its original index. The bookmark dialog is a single `<dialog>` shared between add and edit modes — `editingLinkId === null` means add mode.

Keyboard shortcuts (`N` focus new-todo, `L` open add-bookmark, `D` toggle theme, `/` focus link search, `Escape` clear/blur search) are global but skipped when focus is in an `INPUT`/`TEXTAREA`/`contentEditable` — preserve this guard when adding new shortcuts.
