# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server with HMR
- `npm run build` — production build to `dist/` (also generates the PWA service worker + manifest)
- `npm run preview` — serve the built `dist/` locally
- `npm run icons` — regenerate PWA icons under `public/icons/` from `public/favicon.svg` via `sharp`

No test, lint, or typecheck scripts are configured.

## Architecture

A single-page "Daily Dashboard" (tasks, quick links, saved links, tags) built as **vanilla JS on Vite** — no framework, no TypeScript, no bundler config beyond [vite.config.js](vite.config.js). All behavior lives in three files:

> **Two HTML entries.** The build has two pages: the marketing landing page at the site root
> ([index.html](index.html), styled by [src/landing.css](src/landing.css) with [src/landing.js](src/landing.js)), and the app itself under `/app/`
> ([app/index.html](app/index.html)). They share nothing but the design tokens, which `landing.css` mirrors from
> `style.css`. The landing page must never read or write the app's state; its theme
> preference lives under its own `daily-dashboard:landing-theme` key.

- [app/index.html](app/index.html) — static markup with fixed IDs (`#todo-list`, `#quick-links`, `#saved-links`, `#link-form`, `#toast`, `#theme-toggle`, `#greeting`, `#sync-*`, `#category-*`, `#install-*`, …). `src/main.js` queries these by ID rather than rendering structure, so renaming an ID requires editing both files.
- [src/main.js](src/main.js) — all behavior, organized as flat sections (Storage / State / DOM refs / Header / Theme / Toast / Categories+picker / Todos / Links / Sync dialog / Install / DnD / Init). The Todos and the two Links blocks (quick + saved) all follow the same shape: module-level array → `save*()` → `render*()` → CRUD → form submit listener.
- [src/style.css](src/style.css) — all styling. Theme system is CSS custom properties under `:root` and `[data-theme="light"]`; the JS toggle just flips `data-theme` on `<html>`. Per-tag accent colors are injected via `--cat-color` / `--cat-tint` inline styles by `applyCategoryVars()`.

### Persistence — three tiers

Resolved at startup in this order by `store.load()` in [src/main.js](src/main.js):

1. **`/api/store`** — Vite dev-server middleware in [vite.config.js](vite.config.js) reads/writes `data/store.json` (atomic temp-file rename on write, whitelists known keys, coerces theme). Only active under `npm run dev`. Sets `store.mode = 'file'`.
2. **GitHub gist** — opt-in cross-device sync configured per-browser via the cloud icon → sync dialog. Stores `{ id, token }` in `localStorage['daily-dashboard:gist']`, PATCHes a single file `daily-dashboard.json` inside the private gist. Sets `store.mode = 'gist'`. The header pip reflects status: muted / pulsing accent (syncing) / green (synced) / red (error). A 401 toasts a reminder to rotate the token.
3. **`localStorage['daily-dashboard:store']`** — last-resort per-browser cache, also the synchronous write-through cache for the gist tier so writes survive without network. Sets `store.mode = 'local'`.

`store.save()` is debounced 200ms and dispatches to whichever tier is current. `localStorage` is always written first. A `beforeunload` handler flushes any pending debounced save by writing localStorage synchronously and firing a `fetch({ keepalive: true })` PUT.

**Important constraints:**
- The dev file store and a deployed site's gist/localStorage are **separate buckets** and do not auto-sync.
- The middleware does not run under `npm run preview` or any static host — only `npm run dev`.

### Shared state, in-place mutation

`store.state` is `{ todos, archivedTodos, quickLinks, savedLinks, theme, taskCategories, linkCategories, groupByCategory, groupLinksByCategory, journal, teamLens }`. `journal` is a date-keyed map `{ "YYYY-MM-DD": Entry[] }` where each entry is `{ id, text }`; `teamLens` is `{ activeTeamId, teams, perTeam }` with `perTeam` keyed by team ID (see the Team Lens section in `main.js`). Module-level arrays (`todos`, `quickLinks`, `taskCategories`, …) are *references* into `store.state` — mutations are visible to the serializer without copying. `applyData(state, data)` deliberately uses `arr.splice(0, len, ...newItems)` to refill arrays in place so those references stay valid across loads.

### Legacy migrations (run on every load)

`applyData()` and the dev middleware both fold legacy shapes forward, so old stores keep working:
- A single `links` array → `quickLinks`.
- A single `customCategories` array → `taskCategories`, with a mirrored copy under fresh IDs into `linkCategories` for any category currently referenced by a link. Mirrored IDs are remapped on the link items so the two datasets stay fully independent (renames on one side never bleed to the other).

If you add a new persisted field, add a default to `DEFAULTS` in `vite.config.js`, the `safe = { … }` whitelist in the PUT handler, and `store.state` in `main.js` — otherwise it gets dropped on the next dev save.

### Tags (categories)

Two parallel datasets: `taskCategories` and `linkCategories`. Each category is `{ id, name, color }`. Items reference categories by ID via a `category` field. A custom HSV color picker (`renderColorSwatches`, `bindDrag`, `_rgbToHsv` / `_hsvToRgb`) backs the create dialog; preset swatches live in [app/index.html](app/index.html). The popover for assigning a tag to an item is built by `openCategoryPopover()` — it shares one DOM element, repositioned and rewired on each open.

`groupByCategory` and `groupLinksByCategory` toggle between a flat list and grouped sections; the grouped renderers (`renderGroupedTodos`, `renderGroupedQuickLinks`) build per-category subheaders and route DnD inside the group.

### Rendering & event model

Rendering is **full-list re-render on every change** (`innerHTML = ''` then rebuild). Acceptable at this scale; don't introduce a diffing layer unless lists grow. Items carry a stable `id` (`Date.now() + Math.random()`) and CRUD looks them up by `arr.find(x => x.id === id)`, so reorder doesn't invalidate handlers.

Drag-and-drop is one helper: `setupDnd({ container, itemSelector, groupSelector, getList, axis, onChange })`, wired once per list (active todos, archive, quick links, saved links). Listeners live on the container so they survive re-renders; reorder mutates the backing array via `splice` and calls `onChange` to persist + re-render. When `groupSelector` is provided, drags are constrained inside the same group. Link tiles set `draggable=false` while a search filter is active.

Inline editing uses `contentEditable` spans; `blur` saves, `Enter` blurs. Empty edits delete the item. Deletes show a 4s undo toast that re-splices the removed item back at its original index. The bookmark dialog is a single `<dialog>` shared between add and edit for both link kinds — `editingLinkId === null` is add mode; `editingLinkKind` (`'quick' | 'saved'`) routes which list to write to.

### PWA + offline

[vite.config.js](vite.config.js) wires `vite-plugin-pwa` with `registerType: 'autoUpdate'` and `devOptions.enabled: false` (so the dev file-store middleware isn't shadowed by a service worker). Workbox caches the hashed bundles for offline app-shell. `/api/*` and `api.github.com` are `NetworkOnly` (freshness matters); favicons (`www.google.com/s2/favicons`) and Google Fonts are cached. The install affordance (`updateInstallButton`, install dialog) handles `beforeinstallprompt` on Chromium and falls back to iOS Safari instructions.

The manifest's `start_url` is `./app/` (with `scope: './'`) so an installed PWA opens the app, not the landing page. Because `vite-plugin-pwa` injects the manifest link and the SW registration as page-relative `./manifest.webmanifest` and `./sw.js`, they resolve to `/app/…` and 404 for the nested app entry — `fixNestedPwaPaths()` in [vite.config.js](vite.config.js) rewrites both to `../` after the bundle is written, keeping the worker at the site-root scope so it covers both pages. Landing-page screenshots under `public/screens/` are excluded from the precache via `globIgnores`.

### Browser-extension input guard

`guardPlaceholders()` (called once during `init()`) pins the original `placeholder` on every top-level and in-dialog input and uses a `MutationObserver` plus dialog `close`/`toggle` listeners to scrub the string `"null"`/`"undefined"` if a password manager or form-filler injects them. Preserve this when adding new inputs — add them to the `inputs` array, and add any new `<dialog>` to the scrub list.

### Keyboard shortcuts

Global: `N` focus new-todo, `L` open add-bookmark, `D` toggle theme, `/` focus link search, `Escape` clear/blur search. Skipped when focus is in an `INPUT`/`TEXTAREA`/`contentEditable` — preserve this guard when adding shortcuts.

## Deployment

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on push to `main`. Vite is configured with `base: './'` and the PWA manifest uses relative `start_url`/`scope`, so the build works at any subpath. One-time GitHub setup: **Settings → Pages → Source = GitHub Actions**.

The landing page is served at the Pages root and the app at `<root>/app/`.
