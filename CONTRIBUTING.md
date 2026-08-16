# Contributing to Daily Dashboard

Thanks for your interest in contributing. This document covers everything you need to get the
project running locally, make a change, and open a pull request.

Contributions of all sizes are welcome — bug fixes, accessibility improvements, documentation,
and new features that fit the project's scope.

## Table of contents

- [Prerequisites](#prerequisites)
- [Getting the project running](#getting-the-project-running)
- [Project layout](#project-layout)
- [Architecture guidelines](#architecture-guidelines)
- [Branching](#branching)
- [Commit messages](#commit-messages)
- [Submitting a pull request](#submitting-a-pull-request)
- [Reporting bugs](#reporting-bugs)
- [Suggesting features](#suggesting-features)
- [Code of conduct](#code-of-conduct)

## Prerequisites

- **Node.js** `^20.19.0` or `>=22.12.0` (required by Vite 8 — check with `node -v`, or run `nvm use` to pick up [.nvmrc](.nvmrc))
- **npm** 10 or newer (ships with the Node versions above)
- **git**
- A modern evergreen browser for manual testing (Chrome, Edge, Firefox, or Safari)

No database, API key, or backend service is required to run the project.

## Getting the project running

Fork the repository on GitHub, then clone your fork:

```bash
git clone https://github.com/<your-username>/daily-dashboard.git
```

```bash
cd daily-dashboard
```

Install dependencies:

```bash
npm install
```

Start the development server (Vite, with hot module replacement):

```bash
npm run dev
```

The app is served at <http://localhost:5173>.

### Other useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR. Also enables the `/api/store` middleware that persists to `data/store.json`. |
| `npm run build` | Production build into `dist/`, including the PWA service worker and manifest. |
| `npm run preview` | Serves the built `dist/` locally. Note: the dev file-store middleware does **not** run here. |
| `npm run icons` | Regenerates PWA icons under `public/icons/` from `public/favicon.svg`. |

There are currently no automated test, lint, or typecheck scripts, so **manual verification in the
browser is the expected way to validate a change**. See
[Submitting a pull request](#submitting-a-pull-request) for what to check.

## Project layout

```
index.html          Static markup. Elements are addressed by fixed IDs.
src/main.js         All application behavior, organized into flat sections.
src/style.css       All styling. Themes are CSS custom properties on :root / [data-theme].
vite.config.js      Vite config, PWA plugin, and the dev-only /api/store middleware.
scripts/            Icon generation script.
public/             Favicon, touch icon, generated PWA icons.
.github/workflows/  GitHub Pages deployment.
```

## Architecture guidelines

This project is deliberately small and dependency-light. Please keep contributions compatible with
the existing architecture — [CLAUDE.md](CLAUDE.md) documents it in detail, and is worth reading
before a non-trivial change. The essentials:

- **Vanilla JavaScript on Vite.** No framework, no TypeScript, no build config beyond
  `vite.config.js`. Please don't introduce React/Vue/Svelte, a CSS framework, or a state library.
- **No new runtime dependencies** unless there's a clear reason a small amount of local code can't
  do the job. Open an issue to discuss first.
- **Markup lives in `index.html`; behavior queries it by ID.** `src/main.js` does not render page
  structure, so renaming an ID means editing both files.
- **Full-list re-render on change.** Lists are rebuilt (`innerHTML = ''` then rebuild) on every
  change. Don't add a diffing or virtual-DOM layer.
- **Follow the existing section shape.** Each feature block is: module-level array → `save*()` →
  `render*()` → CRUD functions → form submit listener. New features should match.
- **State references are mutated in place.** Module-level arrays are references into `store.state`.
  Use `splice`/`push` to refill them; reassigning breaks the reference.
- **Adding a persisted field requires three edits**: the `DEFAULTS` object in `vite.config.js`, the
  `safe = { … }` whitelist in the PUT handler, and `store.state` in `src/main.js`. Miss one and the
  field is silently dropped on the next dev save.
- **Themes go through CSS custom properties**, not hardcoded colors.
- **Preserve the input guard.** `guardPlaceholders()` protects inputs from browser extensions that
  inject `"null"` / `"undefined"`. New inputs should be added to its list, and new `<dialog>`
  elements to its scrub list.
- **Preserve the keyboard-shortcut guard.** Global shortcuts are skipped when focus is in an
  `INPUT`/`TEXTAREA`/`contentEditable`.
- **Match the surrounding style.** Two-space indent, single quotes, semicolons, comment density
  similar to neighboring code.

## Branching

Work on a branch off an up-to-date `main` — please don't commit directly to `main`.

```bash
git checkout main && git pull origin main && git checkout -b fix/undo-toast-timing
```

Use a short, descriptive branch name with a type prefix:

- `feat/` — a new feature (`feat/task-due-dates`)
- `fix/` — a bug fix (`fix/gist-401-toast`)
- `docs/` — documentation only (`docs/gist-setup-clarity`)
- `refactor/` — internal change with no behavior change
- `chore/` — tooling, dependencies, CI

Keep one logical change per branch. If you find an unrelated bug along the way, open a separate
issue or branch for it.

## Commit messages

Write commit messages that explain the change to someone reading `git log` a year from now.

- Subject line in the **imperative mood**, under ~72 characters, no trailing period:
  `Fix stuck Quick Links clear button`, not `fixed stuff` or `updates`.
- Leave a blank line, then a body explaining **why** the change was made when it isn't obvious from
  the subject. What changed is visible in the diff; the reasoning usually isn't.
- Reference issues where relevant: `Closes #42`.
- One logical change per commit. Squash noisy work-in-progress commits before opening the PR.

Example:

```
Roll Today's Work view forward when the tab crosses midnight

A long-lived tab kept rendering the previous day's journal entry because
the selected date was captured once at init. Re-check the date on
visibility change so the panel follows the calendar.

Closes #17
```

## Submitting a pull request

1. Push your branch to your fork and open a pull request against `main`.
2. Fill in the pull request template — what changed, why, and how you tested it.
3. Include **before/after screenshots or a short clip for any UI change**. This project has no
   automated UI tests, so screenshots are how reviewers verify visual work.
4. Confirm that unrelated functionality still works. At minimum, before opening the PR:
   - `npm run dev` starts cleanly with no console errors.
   - `npm run build` succeeds.
   - Add, edit, complete, reorder (drag-and-drop), and delete a task; confirm the undo toast works.
   - Add and edit a quick link and a saved link.
   - Toggle light/dark theme and reload — the theme should persist.
   - Reload the page and confirm your data is still there.
   - If you touched persistence, verify all three tiers you can reach: the dev file store
     (`data/store.json` under `npm run dev`), `localStorage`, and — if you have gist sync
     configured — a gist round-trip.
5. Keep the diff focused. Unrelated formatting churn makes review harder; please avoid reformatting
   files you didn't otherwise change.
6. Be ready to iterate — review comments are about the code, not about you.

Draft pull requests are welcome if you'd like early feedback on an approach.

## Reporting bugs

Open a [bug report issue](../../issues/new?template=bug_report.yml). Before filing, please search
existing issues to avoid duplicates.

A useful report includes:

- What you expected to happen, and what actually happened.
- Exact steps to reproduce, starting from a fresh page load.
- Your browser and version, and your OS.
- Whether you're running the dev server, a local production build, or a deployed site — behavior
  differs because the dev file store only exists under `npm run dev`.
- Which storage tier you're on (dev file store / GitHub gist sync / `localStorage`).
- Any errors from the browser console, and a screenshot if the issue is visual.

**Please never paste your GitHub personal access token, gist ID, or the raw contents of a private
gist into an issue.** Redact them before sharing logs or screenshots.

## Suggesting features

Open a [feature request issue](../../issues/new?template=feature_request.yml) describing the problem
you're trying to solve before describing the solution — the underlying need often has a simpler fix
than the first idea.

Please include what you're trying to accomplish, why the current behavior falls short, and any
alternatives you considered. Note that this is a focused single-page personal dashboard; proposals
that require a backend service, a build-system change, or a new framework are unlikely to be a fit,
but are still worth discussing in an issue first.

For anything larger than a small fix, **open an issue before writing code** so we can agree on the
approach and you don't spend effort on a PR that needs to be redirected.

## Code of conduct

Be respectful and constructive. Assume good faith, keep discussion focused on the technical
substance, and remember that everyone involved is contributing their own time. See
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the full text.

## Reporting a security issue

Please **don't** open a public issue for a security vulnerability — including anything involving the
GitHub token used for gist sync. See [SECURITY.md](SECURITY.md) for how to report it privately.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
