// Serves site/ at / and data/ at /data/ on localhost, so the page reads the same paths it uses on Pages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PORT ?? 4321);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  // Only the published data files are served, not the private state cache.
  const isData = /^data\/(apps\.json|files\.json|unofficial\.json|history\/[\w-]+\.json)$/.test(relative);
  const base = relative.startsWith('data/') ? ROOT : join(ROOT, 'site');
  const file = resolve(base, normalize(relative));
  if (relative.startsWith('data/') && !isData) {
    res.writeHead(404).end('not found');
    return;
  }
  if (!file.startsWith(resolve(base))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Craft Watch running at http://localhost:${PORT}  (Ctrl+C to stop)`);
});
