<div align="center">

<img src="public/favicon.svg" alt="" width="72" height="72">

# Daily Dashboard

**Tasks, a daily journal, team status, and bookmarks — on one page you can leave open in a tab.**

Vanilla JS on Vite. No framework, no TypeScript, no backend.<br>
No account, no telemetry — your data stays in your browser.

[![CI](https://github.com/jihadabuzuhri/daily-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/jihadabuzuhri/daily-dashboard/actions/workflows/ci.yml)
[![Deploy](https://github.com/jihadabuzuhri/daily-dashboard/actions/workflows/deploy.yml/badge.svg)](https://github.com/jihadabuzuhri/daily-dashboard/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Vite](https://img.shields.io/badge/built%20with-Vite-646CFF.svg)](https://vite.dev)
[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8.svg)](#features)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**[Live app](https://jihadabuzuhri.github.io/daily-dashboard/app/)**
· [Project page](https://jihadabuzuhri.github.io/daily-dashboard/)
· [Quick start](#quick-start)
· [Contributing](CONTRIBUTING.md)

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/hero-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/hero-light.png">
  <img alt="Daily Dashboard: a Today's Work journal panel beside a Team Lens panel showing an on-track status pill, a waiting-on list, and per-team links." src=".github/assets/hero-dark.png" width="900">
</picture>

<sub>The running app with sample data. Light and dark themes ship together.</sub>

</div>

---

## Why it exists

The things you need to stay oriented during a workday are usually scattered: a to-do app, a notes
file for what you actually got done, a browser bookmark bar you've stopped pruning, and a mental
list of who owes you what. Daily Dashboard puts them on one page.

It's built for people who want that without signing up for a hosted service or standing up a
server. There is no account, no telemetry, and no backend — your data lives in your browser, in a
local file while developing, or in a private gist you own and can revoke at any time. The whole app
is three files (`app/index.html`, `src/main.js`, `src/style.css`), so it's small enough to read end
to end and change to fit how you actually work.

## At a glance

| | |
| --- | --- |
| **Today's Work** | A journal for what you actually got done. Completed tasks log themselves into today's entry. |
| **Team Lens** | Per-team status pill, a *waiting on* list, and the links you pivot to most. |
| **Tasks** | Tags, grouping, drag-and-drop, an archive, undo on delete, and optional focus sessions. |
| **Quick Links & Saved for Later** | A pinned grid plus a searchable archive, both taggable and reorderable. |
| **Local-first storage** | A local file in dev, `localStorage` everywhere else, and an optional private gist. |
| **PWA & offline** | Installable, and the app shell is cached so it opens without a network. |

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Where your data lives](#where-your-data-lives)
- [Cross-device sync via Gist](#cross-device-sync-via-gist)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)

## Quick start

**Prerequisites**

- **Node.js** `^20.19.0` or `>=22.12.0` — required by Vite 8. Check with `node -v`, or run `nvm use` to pick up [.nvmrc](.nvmrc).
- **npm** 10 or newer
- A modern evergreen browser

No database, API key, or backend service is needed to run the app.

**Install and run**

```bash
git clone https://github.com/jihadabuzuhri/daily-dashboard.git
```

```bash
cd daily-dashboard && npm install
```

```bash
npm run dev
```

Open <http://localhost:5173/app/> for the app, or <http://localhost:5173> for the landing page.

**Scripts**

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR, plus the `/api/store` middleware that persists to `data/store.json`. |
| `npm run build` | Production build to `dist/`, including the PWA service worker and manifest. |
| `npm run preview` | Serves the built `dist/` locally (without the dev file-store middleware). |
| `npm run icons` | Regenerates PWA icons under `public/icons/` from `public/favicon.svg`. |

> [!NOTE]
> There are no automated test, lint, or typecheck scripts — changes are verified manually in the
> browser. See [CONTRIBUTING.md](CONTRIBUTING.md) for the checklist.

## Features

<details open>
<summary><b>Today's Work</b> — the journal that writes half of itself</summary>

- Full-width panel at the top of the dashboard for logging what you accomplished each day.
- Custom date picker with previous/next arrows and a calendar popover to jump to any day.
- Completed tasks are auto-logged into today's entry, so the journal builds itself as you check things off.
- Inline edit, delete, and reorder via drag-and-drop.

</details>

<details>
<summary><b>Team Lens</b> — status and blockers, per team</summary>

- Per-team status card: a colored status pill (*Idle / On track / At risk / Blocked*) with a one-line note.
- **Waiting on** list — the people or items blocking you, tracked per team.
- Per-team **links** grid for the runbooks, dashboards, or repos you pivot to most.
- Overview mode summarizes every team's status at a glance; click a row to focus one team.
- Fully independent of the Tasks panel.

</details>

<details>
<summary><b>Tasks</b> — with tags, grouping, and focus sessions</summary>

- Add, edit (inline `contentEditable`), check off, archive, and delete tasks.
- Progress bar and live count of remaining items in the panel header.
- 4-second undo toast after a delete restores the item to its original position.
- Drag-and-drop reordering — also constrained inside groups when grouping is on.
- Archived section (collapsible) preserves completed work without crowding the active list.
- Per-task **tag** assignment via a shared popover; tags can be created on the fly with name + color.
- **Group by tag** toggle splits the list into per-tag sections with their own subheaders.
- Optional **focus session** per task: pick 15/25/50 minutes or a custom duration; runs a Pomodoro-style countdown.
  - Header "focus pill" stays visible across the app with a progress ring and a stop button.
  - Full-screen focus dialog with animated ring while running; minimize to keep working.

</details>

<details>
<summary><b>Quick Links & Saved for Later</b> — the bookmark bar you'd actually prune</summary>

- Two parallel link collections: pinned **Quick Links** grid up top, collapsible **Saved for Later** archive below.
- Favicons fetched from Google's `s2/favicons` service (cached by the service worker).
- Add / edit dialog handles both kinds with one form.
- Per-link **tag** assignment with the same color system as tasks.
- **Search** box per panel filters tiles in place (drag is disabled while filtering).
- **Group by tag** toggle for the quick links grid.
- Drag-and-drop reorder, inline edit, undo-delete (same 4-second toast).

</details>

<details>
<summary><b>Tags</b> — two independent datasets, one color system</summary>

- Two independent tag datasets: one for tasks, one for links — renames on one side never bleed to the other.
- Each tag is `{ name, color }`. Color comes from preset swatches **or** a custom HSV picker (S/V plane + hue slider + hex input).
- Categories drive accent colors throughout the UI via CSS custom properties.

</details>

<details>
<summary><b>Theme</b> — light and dark, persisted</summary>

- Light/dark themes via a header toggle (`D` shortcut). The chosen theme is persisted alongside everything else.
- Subtle background aurora + film-grain layers respond to the active theme.

</details>

<details>
<summary><b>PWA & offline</b> — installable, works without a network</summary>

- Installable on Chromium browsers via the **Install** button (uses `beforeinstallprompt`).
- iOS fallback dialog explains the *Share → Add to Home Screen* flow for Safari.
- Service worker (Workbox) caches the app shell + Google Fonts + favicon proxy for offline use.
- `autoUpdate` registration: new builds activate on next reload.
- iOS web-app meta tags, theme-color, and Apple touch icon are all wired up.

</details>

<details>
<summary><b>Browser-extension input guard</b> — a small defense against form-fillers</summary>

- A `MutationObserver` pins every input's original `placeholder` and scrubs the strings `"null"` / `"undefined"` if a password manager or form-filler injects them.

</details>

### Keyboard shortcuts

Global, and skipped while you're typing in an input, textarea, or `contentEditable`:

| Key | Action |
| :---: | --- |
| <kbd>N</kbd> | Focus the new-task input |
| <kbd>L</kbd> | Open the add-bookmark dialog |
| <kbd>/</kbd> | Focus the link search |
| <kbd>Esc</kbd> | Clear / blur the search |
| <kbd>D</kbd> | Toggle theme |

## Where your data lives

The app stores tasks, journal entries, team status, bookmarks, tags, theme, and grouping
preferences in three tiers, resolved at startup in this order:

| | Tier | Where | When it's used |
| :---: | --- | --- | --- |
| 1 | **Local file** | `data/store.json`, via a Vite dev-server middleware ([vite.config.js](vite.config.js)) | Only under `npm run dev` |
| 2 | **Private GitHub gist** | A gist you own, synced over `api.github.com` | Opt-in, configured per browser via the cloud icon |
| 3 | **`localStorage`** | Key `daily-dashboard:store` | The fallback everywhere else, and the write-through cache for tier 2 |

Writes are debounced 200 ms; `beforeunload` flushes any pending save synchronously to `localStorage`
and (when configured) fires a `keepalive` PATCH to the gist.

**Nothing is sent anywhere else.** There is no analytics, no account system, and no server component
beyond the optional gist you own.

> [!IMPORTANT]
> The dev file store and gist/`localStorage` on a deployed site are **separate buckets** and do not
> auto-sync.

## Cross-device sync via Gist

The deployed (static) app can sync state across browsers and devices using a private GitHub gist as
the backend. Opt-in per browser, free, no extra infrastructure.

<details>
<summary><b>One-time setup</b></summary>

1. Create a **private gist** at <https://gist.github.com> containing a single file named exactly `daily-dashboard.json` with contents `{}`.
2. Copy the gist ID from the URL (`https://gist.github.com/<user>/<gist-id-here>`).
3. Create a **fine-grained PAT** at <https://github.com/settings/tokens?type=beta>:
   - **Repository access**: *None*
   - **Account permissions**: *Gists* → **Read and write**
   - **Expiration**: your call (90 days is reasonable; the app will toast on 401 so you know to rotate)
4. On the deployed site, click the **cloud icon** in the header → paste the gist ID + token → **Save**.

If the gist is empty on first save, the app uploads your current local state. Otherwise the gist is
authoritative and replaces local state.

</details>

<details>
<summary><b>Behavior</b></summary>

- **On load**: the gist content overwrites local state, then renders.
- **On save**: writes go to `localStorage` synchronously, then PATCH the gist (debounced 200 ms).
- **Conflict policy**: last-write-wins. Don't edit the same dashboard from two devices simultaneously.
- **Manual refresh**: the sync dialog has a *Refresh* button to pull the latest gist (e.g. after editing on another device).
- **Offline**: writes stay in `localStorage`; next successful PATCH pushes them up.

The dot on the cloud icon reflects sync state at a glance: muted = local-only, accent (pulsing) =
syncing, green = synced, red = error.

</details>

<details>
<summary><b>Where the token lives</b></summary>

- Stored in `localStorage` under `daily-dashboard:gist` on the device where you entered it.
- Sent only to `api.github.com` over TLS.
- Scoped to the `gist` permission — worst-case leak gives access to your gists, not your repos.
- Clearing browser site data (or clicking *Disable*) wipes the config.

</details>

## Project structure

```
app/index.html      The app. Static markup; elements are addressed by fixed IDs.
src/main.js         All application behavior, organized into flat sections.
src/style.css       All styling. Themes are CSS custom properties on :root / [data-theme].

index.html          The landing page, served at the site root.
src/landing.css     Landing-page styling. Mirrors the app's design tokens.
src/landing.js      Landing-page theme toggle. Independent of the app's state.

vite.config.js      Vite config, PWA plugin, and the dev-only /api/store middleware.
scripts/            Icon generation script.
public/             Favicon, touch icon, generated PWA icons, landing screenshots.
.github/workflows/  CI and GitHub Pages deployment.
```

The build has two HTML entries: the landing page at the site root and the app under `/app/`.

> [!TIP]
> [CLAUDE.md](CLAUDE.md) documents the internal architecture — persistence tiers, the render/event
> model, drag-and-drop, and the legacy-data migrations — in more depth than this README.

## Deployment

Pushing to `main` triggers [`deploy.yml`](.github/workflows/deploy.yml), which builds and publishes
to GitHub Pages. One-time setup on the repo: **Settings → Pages → Source = GitHub Actions**.

| URL | Serves |
| --- | --- |
| `https://<user>.github.io/<repo>/` | The landing page |
| `https://<user>.github.io/<repo>/app/` | The app |

The Vite config uses `base: './'`, so asset URLs are relative and the build works at any subpath.
Because the build is a static bundle with no server requirement, it also deploys unchanged to
Netlify, Vercel, Cloudflare Pages, or any static host.

## Contributing

Contributions are welcome — bug fixes, accessibility improvements, documentation, and features that
fit the project's scope.

Please read **[CONTRIBUTING.md](CONTRIBUTING.md)** first. It covers local setup, branch naming,
commit-message expectations, the manual-verification checklist to run before opening a pull request,
and the architecture constraints new code should stay compatible with (vanilla JS, no framework, no
new runtime dependencies).

| | |
| --- | --- |
| 🐛 | [Report a bug](https://github.com/jihadabuzuhri/daily-dashboard/issues/new?template=bug_report.yml) |
| 💡 | [Suggest a feature](https://github.com/jihadabuzuhri/daily-dashboard/issues/new?template=feature_request.yml) |
| 🤝 | [Code of Conduct](CODE_OF_CONDUCT.md) |
| 🔒 | [Security policy](SECURITY.md) — please report vulnerabilities privately, not as public issues |

For anything larger than a small fix, please open an issue to discuss the approach before writing
code. Pull requests are built against Node 20 and 22 by [the CI workflow](.github/workflows/ci.yml).

## License

Licensed under the [MIT License](LICENSE).

<div align="center">
<br>
<sub>Built with vanilla JS and Vite.</sub>
</div>
