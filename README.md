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

The app stores tasks, bookmarks, and theme in three tiers, resolved at startup in this order:

1. **`data/store.json`** via a Vite dev-server middleware ([vite.config.js](vite.config.js)). Active only under `npm run dev`.
2. **A private GitHub gist** — opt-in cross-device sync. Configure per-browser via the cloud icon in the header. See below.
3. **`localStorage`** (key `daily-dashboard:store`) — per-browser fallback, also the synchronous write-through cache for the gist tier.

The dev file store and gist/localStorage on a deployed site are **separate buckets** and do not auto-sync.

## Cross-device sync via Gist

The deployed (static) app can sync state across browsers and devices using a private GitHub gist as the backend. Opt-in per browser, free, no extra infrastructure.

### One-time setup

1. Create a **private gist** at <https://gist.github.com> containing a single file named exactly `daily-dashboard.json` with contents `{}`.
2. Copy the gist ID from the URL (`https://gist.github.com/<user>/<gist-id-here>`).
3. Create a **fine-grained PAT** at <https://github.com/settings/tokens?type=beta>:
   - **Repository access**: *None*
   - **Account permissions**: *Gists* → **Read and write**
   - **Expiration**: your call (90 days is reasonable; the app will toast on 401 so you know to rotate)
4. On the deployed site, click the **cloud icon** in the header → paste the gist ID + token → **Save**.

If the gist is empty on first save, the app uploads your current local state. Otherwise the gist is authoritative and replaces local state.

### Behavior

- **On load**: the gist content overwrites local state, then renders.
- **On save**: writes go to `localStorage` synchronously, then PATCH the gist (debounced 200ms).
- **Conflict policy**: last-write-wins. Don't edit the same dashboard from two devices simultaneously.
- **Manual refresh**: the sync dialog has a *Refresh* button to pull the latest gist (e.g. after editing on another device).
- **Offline**: writes stay in `localStorage`; next successful PATCH pushes them up.

### Where the PAT lives

- Stored in `localStorage` under `daily-dashboard:gist` on the device where you entered it.
- Sent only to `api.github.com` over TLS.
- Scoped to the `gist` permission — worst-case leak gives access to your gists, not your repos.
- Clearing browser site data (or clicking *Disable*) wipes the config.

### Pip in the header

The dot on the cloud icon reflects sync state at a glance: muted = local-only, accent (pulsing) = syncing, green = synced, red = error.
