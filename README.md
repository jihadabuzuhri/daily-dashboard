# Daily Dashboard

A single-page dashboard for daily tasks and bookmarks. Vanilla JS on Vite — no framework, no TypeScript.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
```

`npm run build` produces a static bundle in `dist/`. `npm run preview` serves it locally.

## Deployment (GitHub Pages)

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and publishes to GitHub Pages.

One-time setup on the GitHub repo: **Settings → Pages → Source = GitHub Actions**.

The site will be served at `https://<user>.github.io/<repo>/`. The Vite config uses `base: './'`, so asset URLs are relative and the build works at any subpath.

## Data persistence

The app stores tasks, bookmarks, and theme in two places, in order of preference:

1. **`data/store.json`** via a tiny Vite dev-server middleware ([vite.config.js](vite.config.js)). Active only under `npm run dev`.
2. **`localStorage`** under the key `daily-dashboard:store`. Used automatically whenever the dev middleware isn't reachable (i.e. `npm run preview`, GitHub Pages, any static host).

On startup, `store.load()` tries the file API first and falls back to `localStorage`. Writes mirror to `localStorage` whenever the PUT to `/api/store` fails, so the deployed (static) build persists per-browser without any extra infrastructure.

Data from the dev file store and a deployed browser's localStorage are **separate** — they don't sync.
