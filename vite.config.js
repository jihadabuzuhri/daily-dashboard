import { defineConfig } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_FILE = path.resolve(__dirname, 'data', 'store.json');

const DEFAULTS = {
  todos: [],
  archivedTodos: [],
  links: [],
  theme: 'dark',
};

async function readStore() {
  try {
    const text = await fs.readFile(STORE_FILE, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(text) };
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
            // Only persist known keys to avoid junk
            const safe = {
              todos: Array.isArray(parsed.todos) ? parsed.todos : [],
              archivedTodos: Array.isArray(parsed.archivedTodos) ? parsed.archivedTodos : [],
              links: Array.isArray(parsed.links) ? parsed.links : [],
              theme: parsed.theme === 'light' ? 'light' : 'dark',
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
  plugins: [fileStorePlugin()],
});
