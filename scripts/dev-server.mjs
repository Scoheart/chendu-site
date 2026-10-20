// Local harness that mimics the Vercel deployment: static files from the repo root
// (index.html, assets/, issues/) plus the Node functions under api/.
//   DATABASE_URL=postgres://... PORT=3000 npm run dev:local
// `vercel dev` works too; this exists so the site can be tested without a Vercel login.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = +process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };
const STATIC = /^\/(index\.html$|assets\/|issues\/|$)/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith('/api/')) {
    const name = p.replace(/\/+$/, '').slice(5);
    if (!/^[a-z/]+$/.test(name)) { res.statusCode = 404; return res.end('not found'); }
    try {
      const mod = await import(join(ROOT, 'api', name + '.js'));
      return mod.default(req, res);
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND') { res.statusCode = 404; return res.end('not found'); }
      throw e;
    }
  }
  if (!STATIC.test(p) || p.includes('..')) { res.statusCode = 404; return res.end('not found'); }
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  try {
    const st = await stat(file);
    if (st.isDirectory()) { res.statusCode = 308; res.setHeader('Location', url.pathname + '/'); return res.end(); }
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('not found'); }
});
server.listen(PORT, () => console.log(`chendu dev server on http://localhost:${PORT}`));
