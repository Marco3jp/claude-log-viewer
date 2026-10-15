import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refresh, search, suggestPaths, sessionDetail, agentEvents, getSession, PROJECTS_DIR } from './lib/index.js';
import { setBookmark } from './lib/bookmarks.js';

const PORT = Number(process.env.PORT) || 4317;
// 会話ログにはコードや認証まわりの出力がそのまま入っているので、ループバック以外では待ち受けない
const HOST = '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function filters(params) {
  const f = {};
  for (const key of new Set(params.keys())) {
    const v = params.getAll(key);
    f[key] = v.length > 1 ? v : v[0];
  }
  return f;
}

// DNS リバインディングで外部のページから API を読まれないように、Host がループバックのときだけ応える
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer((req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/sessions') return json(res, 200, search(filters(url.searchParams)));
    if (url.pathname === '/api/paths') {
      return json(res, 200, suggestPaths(url.searchParams.get('q'), url.searchParams.get('mode') ?? 'any'));
    }
    if (url.pathname === '/api/session') {
      const d = sessionDetail(url.searchParams.get('id') ?? '');
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/bookmark') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const id = url.searchParams.get('id') ?? '';
      if (!getSession(id)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { id, bookmarked: setBookmark(id, url.searchParams.get('on') === '1') });
    }
    if (url.pathname === '/api/agent') {
      const d = agentEvents(url.searchParams.get('session') ?? '', url.searchParams.get('agent') ?? '');
      return d ? json(res, 200, d) : json(res, 404, { error: 'not found' });
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC, path.normalize(name));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

const t = Date.now();
refresh();
console.log(`${PROJECTS_DIR} を読み込みました (${Date.now() - t}ms)`);
server.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}/`));
