import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.resolve(__dirname, 'data', 'store.json');

const DEFAULTS = {
  todos: [],
  archivedTodos: [],
  quickLinks: [],
  savedLinks: [],
  theme: 'dark',
  taskCategories: [],
  linkCategories: [],
  groupByCategory: false,
  groupLinksByCategory: false,
  journal: {},
  teamLens: { activeTeamId: null, teams: [], perTeam: {} },
};

async function readStore() {
  try {
    const text = await fs.readFile(STORE_FILE, 'utf-8');
    const parsed = JSON.parse(text);
    // Legacy migration: a single `links` array becomes quickLinks. Done on read so
    // existing data files keep working until the next write normalizes them.
    if (Array.isArray(parsed.links) && !Array.isArray(parsed.quickLinks)) {
      parsed.quickLinks = parsed.links;
    }
    delete parsed.links;
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULTS };
    throw err;
  }
}

async function writeStore(data) {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  // Write to a temp file then rename for atomicity (avoids partial writes if the
  // dev server is interrupted mid-write).
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, STORE_FILE);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function fileStorePlugin() {
  return {
    name: 'file-store',
    configureServer(server) {
      server.middlewares.use('/api/store', async (req, res, next) => {
        try {
          if (req.method === 'GET') {
            const data = await readStore();
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(data));
            return;
          }
          if (req.method === 'PUT') {
            const body = await readBody(req);
            const parsed = JSON.parse(body);
            // Only persist known keys to avoid junk. Legacy `links` folds into quickLinks.
            const safe = {
              todos: Array.isArray(parsed.todos) ? parsed.todos : [],
              archivedTodos: Array.isArray(parsed.archivedTodos) ? parsed.archivedTodos : [],
              quickLinks: Array.isArray(parsed.quickLinks)
                ? parsed.quickLinks
                : (Array.isArray(parsed.links) ? parsed.links : []),
              savedLinks: Array.isArray(parsed.savedLinks) ? parsed.savedLinks : [],
              theme: parsed.theme === 'light' ? 'light' : 'dark',
              taskCategories: Array.isArray(parsed.taskCategories)
                ? parsed.taskCategories
                : (Array.isArray(parsed.customCategories) ? parsed.customCategories : []),
              linkCategories: Array.isArray(parsed.linkCategories) ? parsed.linkCategories : [],
              groupByCategory: !!parsed.groupByCategory,
              groupLinksByCategory: !!parsed.groupLinksByCategory,
              // Journal — date-keyed { "YYYY-MM-DD": Entry[] }. Each entry is
              // { id, text }. Legacy string values are accepted on read so an
              // existing single-line file still loads cleanly (the client
              // migrates them to entry objects).
              journal: (parsed.journal && typeof parsed.journal === 'object' && !Array.isArray(parsed.journal))
                ? Object.fromEntries(Object.entries(parsed.journal).filter(([, v]) => Array.isArray(v) || typeof v === 'string'))
                : {},
              // Team Lens — independent dataset. Has its own `teams` list
              // (not piggy-backed on taskCategories) and its own per-team
              // bucket of tasks, scratchpad, decisions, questions, on-call,
              // and PR/mention counts.
              teamLens: (parsed.teamLens && typeof parsed.teamLens === 'object' && !Array.isArray(parsed.teamLens))
                ? {
                    activeTeamId: typeof parsed.teamLens.activeTeamId === 'string' ? parsed.teamLens.activeTeamId : null,
                    teams: Array.isArray(parsed.teamLens.teams) ? parsed.teamLens.teams : [],
                    perTeam: (parsed.teamLens.perTeam && typeof parsed.teamLens.perTeam === 'object' && !Array.isArray(parsed.teamLens.perTeam))
                      ? parsed.teamLens.perTeam : {},
                  }
                : { activeTeamId: null, teams: [], perTeam: {} },
            };
            await writeStore(safe);
            res.statusCode = 204;
            res.end();
            return;
          }
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, PUT');
          res.end('Method not allowed');
        } catch (err) {
          server.config.logger.error(`[file-store] ${err.stack || err.message}`);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: err.message }));
        }
      });
    },
  };
}

// vite-plugin-pwa injects the manifest link and the service-worker registration
// with paths relative to the *page* ("./manifest.webmanifest", "./sw.js"). Those
// are correct for the landing page at the site root, but the app is served from
// /app/, where they resolve to /app/manifest.webmanifest and /app/sw.js — both
// 404, and the worker would register under the /app/ scope. Rewrite them to
// point back up at the root for any HTML entry in a subdirectory.
//
// This runs in closeBundle rather than transformIndexHtml because the PWA plugin
// injects those tags after every transformIndexHtml hook has already run — by
// then the only copy of the markup is the file on disk.
function fixNestedPwaPaths() {
  let outDir;
  return {
    name: 'fix-nested-pwa-paths',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle: {
      order: 'post',
      sequential: true,
      async handler() {
        const entries = await fs.readdir(outDir, { withFileTypes: true, recursive: true });
        for (const entry of entries) {
          if (!entry.isFile() || entry.name !== 'index.html') continue;
          const file = path.join(entry.parentPath ?? entry.path, entry.name);
          const depth = path.relative(outDir, file).split(path.sep).length - 1;
          if (depth === 0) continue;
          const up = '../'.repeat(depth);
          const html = await fs.readFile(file, 'utf-8');
          const fixed = html
            .replace(/(href|src)="\.\/(manifest\.webmanifest|sw\.js|registerSW\.js)"/g, `$1="${up}$2"`)
            .replace(/register\(\s*'\.\/sw\.js'\s*,\s*\{\s*scope:\s*'\.\/'\s*\}\s*\)/g,
              `register('${up}sw.js', { scope: '${up}' })`);
          if (fixed !== html) await fs.writeFile(file, fixed);
        }
      },
    },
  };
}

export default defineConfig({
  // Relative base so the build works at any subpath (e.g. GitHub Pages at /<repo>/).
  base: './',
  build: {
    rollupOptions: {
      // Two HTML entries: the marketing/landing page at the site root, and the
      // app itself under /app/. Keeping the app in its own directory means the
      // landing page owns the root URL without either one shadowing the other.
      input: {
        landing: path.resolve(__dirname, 'index.html'),
        app: path.resolve(__dirname, 'app/index.html'),
      },
    },
    // Vite's default CSS minifier (esbuild) aggressively collapses prefix
    // families: with the `modules` cssTarget it dropped the unprefixed
    // `backdrop-filter` because Safari 14 wants `-webkit-` and FF78 doesn't
    // support the feature at all. That broke blur in Firefox 103+, which only
    // accepts the unprefixed form. Force-targeting modern Firefox via
    // cssTarget alone wasn't enough — esbuild ignored it. lightningcss is
    // browser-target-aware and keeps both forms when needed.
    cssMinify: 'lightningcss',
    cssTarget: ['chrome87', 'firefox103', 'safari14', 'edge88'],
  },
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      targets: {
        chrome: 87 << 16,
        firefox: 103 << 16,
        safari: 14 << 16,
      },
    },
  },
  plugins: [
    fileStorePlugin(),
    VitePWA({
      // Auto-update the service worker when a new build is deployed. No prompts.
      registerType: 'autoUpdate',
      // Inline the registration snippet rather than emitting registerSW.js, so
      // fixNestedPwaPaths() can rewrite the sw.js path per page (see above).
      injectRegister: 'inline',
      // Disable SW in dev so the file-store middleware works normally.
      // Set `devOptions.enabled: true` if you need to debug the SW locally.
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icons/*.png'],
      manifest: {
        name: 'Daily — Dashboard',
        short_name: 'Daily',
        description: 'A quiet command center for tasks and bookmarks.',
        // Relative scope/start_url so the manifest works under GitHub Pages
        // subpaths. The manifest is emitted at the site root, so scope './'
        // covers both the landing page and the app; start_url points at the
        // app so launching the installed PWA opens the dashboard, not the
        // landing page.
        start_url: './app/',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#0e0e12',
        theme_color: '#0e0e12',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Cache the hashed bundles + index.html for offline app-shell.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Landing-page screenshots are ~230 KB and only ever shown at the site
        // root. Keeping them out of the precache keeps the app's offline
        // install payload to the app shell itself.
        globIgnores: ['**/screens/**'],
        // Never cache the dev file-store endpoint or gist API calls.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Bypass the SW entirely for /api/store; freshness matters.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
          {
            // Gist sync also needs network freshness; let it fail naturally when offline.
            urlPattern: ({ url }) => url.hostname === 'api.github.com',
            handler: 'NetworkOnly',
          },
          {
            // Favicons are nice to keep around when offline.
            urlPattern: ({ url }) => url.hostname === 'www.google.com' && url.pathname.startsWith('/s2/favicons'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'favicons',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // Google Fonts CSS + font files.
            urlPattern: ({ url }) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts' },
          },
        ],
      },
    }),
    // After VitePWA so its injected tags are already present in the HTML.
    fixNestedPwaPaths(),
  ],
});
