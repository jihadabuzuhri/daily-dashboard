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

export default defineConfig({
  // Relative base so the build works at any subpath (e.g. GitHub Pages at /<repo>/).
  base: './',
  plugins: [
    fileStorePlugin(),
    VitePWA({
      // Auto-update the service worker when a new build is deployed. No prompts.
      registerType: 'autoUpdate',
      // Disable SW in dev so the file-store middleware works normally.
      // Set `devOptions.enabled: true` if you need to debug the SW locally.
      devOptions: { enabled: false },
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'icons/*.png'],
      manifest: {
        name: 'Daily — Dashboard',
        short_name: 'Daily',
        description: 'A quiet command center for tasks and bookmarks.',
        // Use relative scope/start_url so the manifest works under GitHub Pages subpaths.
        start_url: './',
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
  ],
});
