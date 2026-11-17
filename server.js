import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refresh, takeChanges, search, suggestPaths, sessionDetail, agentEvents, subagents, getSession, recentCwds, PROJECTS_DIR } from './lib/index.js';
import { renderStatus, clearStatusCache, claudeStatusCommand } from './lib/statusline.js';
import { getSettings, setStatusLine } from './lib/settings.js';
import { setBookmark } from './lib/bookmarks.js';
import { getMemo, setMemo, MEMO_MAX } from './lib/memos.js';
import { send, create, answer, interrupt, stopAll, runnerState, runnerCwd, openElsewhere, onRunnerChange } from './lib/runner.js';

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
// ほかのサイトを開いたブラウザからも POST は届くので、このビュワーのページから来たものだけ受ける
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));
const BODY_MAX = 1024 * 1024;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(new Error('本文が大きすぎます'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON として読めません'));
      }
    });
    req.on('error', reject);
  });
}

async function handleRunner(req, res, url) {
  if (url.pathname === '/api/runner') {
    const id = url.searchParams.get('id') ?? '';
    return json(res, 200, { ...runnerState(id), elsewhere: openElsewhere(id) });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'application/json only' });
  const body = await readJson(req);
  const text = String(body.text ?? '').trim();
  if (url.pathname === '/api/runner/new') {
    if (!text) return json(res, 400, { error: '送る内容が空です' });
    const out = create(String(body.cwd ?? '').trim(), text, String(body.permissionMode ?? ''));
    return out.error ? json(res, out.code ?? 400, { error: out.error }) : json(res, 200, out.state);
  }
  const id = String(body.id ?? '');
  const s = getSession(id);
  const cwd = s?.cwd ?? runnerCwd(id);
  if (!cwd) return json(res, 404, { error: 'not found' });
  let out;
  if (url.pathname === '/api/runner/send') {
    if (!text) return json(res, 400, { error: '送る内容が空です' });
    out = send(id, cwd, text, s?.permissionMode);
  } else if (url.pathname === '/api/runner/answer') {
    out = answer(id, String(body.requestId ?? ''), body);
  } else if (url.pathname === '/api/runner/interrupt') {
    out = interrupt(id);
  } else {
    return json(res, 404, { error: 'not found' });
  }
  return out.error ? json(res, out.code ?? 400, { error: out.error }) : json(res, 200, out.state);
}

// fs.watch は macOS のサンドボックス内で EMFILE になるなど環境によって使えないので、更新時刻を見に行く。
// 変わっていなければ 1,000 セッションほどで十数ミリ秒
const POLL_MS = 2000;
// ステータスラインのコマンドはサーバーが動かすので、設定はブラウザではなくサーバー側に持つ
async function handleSettings(req, res) {
  if (req.method === 'GET') return json(res, 200, { ...getSettings(), claudeStatusCommand: claudeStatusCommand() });
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'application/json only' });
  const body = await readJson(req);
  const out = setStatusLine(body.statusLine ?? {});
  if (out.error) return json(res, 400, { error: out.error });
  clearStatusCache();
  return json(res, 200, { ...out.settings, claudeStatusCommand: claudeStatusCommand() });
}

async function handleMemo(req, res, url) {
  if (req.method === 'GET') {
    const m = getMemo(url.searchParams.get('id') ?? '');
    return m ? json(res, 200, m) : json(res, 400, { error: 'id が正しくありません' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'application/json only' });
  const body = await readJson(req);
  const id = String(body.id ?? '');
  const text = String(body.text ?? '');
  if (!getSession(id)) return json(res, 404, { error: 'not found' });
  if (text.length > MEMO_MAX) return json(res, 413, { error: 'メモが長すぎます' });
  return json(res, 200, setMemo(id, text));
}

const listeners = new Set();
setInterval(() => {
  refresh();
  const { ids, replies } = takeChanges();
  if (!ids.length) return;
  const msg = `data: ${JSON.stringify({ ids, replies })}\n\n`;
  for (const res of listeners) res.write(msg);
}, POLL_MS);
onRunnerChange((state) => {
  const msg = `event: runner\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of listeners) res.write(msg);
});

const server = http.createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !ALLOWED_ORIGINS.has(req.headers.origin ?? '')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/runner' || url.pathname.startsWith('/api/runner/')) return await handleRunner(req, res, url);
    if (url.pathname === '/api/memo') return await handleMemo(req, res, url);
    if (url.pathname === '/api/cwds') return json(res, 200, recentCwds());
    if (url.pathname === '/api/settings') return await handleSettings(req, res);
    if (url.pathname === '/api/statusline') {
      const s = getSession(url.searchParams.get('id') ?? '');
      return s ? json(res, 200, await renderStatus(s)) : json(res, 404, { error: 'not found' });
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.write('retry: 3000\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;
    }
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
    if (url.pathname === '/api/subagents') {
      const list = subagents(url.searchParams.get('id') ?? '');
      return list ? json(res, 200, list) : json(res, 404, { error: 'not found' });
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
takeChanges();
console.log(`${PROJECTS_DIR} を読み込みました (${Date.now() - t}ms)`);
server.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}/`));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopAll();
    process.exit(0);
  });
}
