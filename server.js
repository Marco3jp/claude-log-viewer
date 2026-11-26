import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { refresh, takeChanges, search, suggestPaths, sessionDetail, agentEvents, subagents, getSession, recentCwds, PROJECTS_DIR } from './lib/index.js';
import { renderStatus, clearStatusCache, claudeStatusCommand } from './lib/statusline.js';
import { getSettings, setStatusLine, setHideRules, setReview } from './lib/settings.js';
import { CONDITIONS } from './lib/review-conditions.js';
import { hookCommand } from './lib/hook-command.js';
import { sendViaTmux } from './lib/tmux.js';
import { setBookmark } from './lib/bookmarks.js';
import { setHidden, listHidden } from './lib/hidden.js';
import { getMemo, setMemo, MEMO_MAX } from './lib/memos.js';
import { send, create, answer, interrupt, stopAll, beginClosing, busyIds, runnerState, runnerCwd, openElsewhere, otherStates, onRunnerChange, sessionStatuses } from './lib/runner.js';
import { review, reviewState, answerReview, onReviewChange, checkHookToken, hookToken, syncSessionStatuses, decisionsFor } from './lib/review.js';

const PORT = Number(process.env.PORT) || 4317;
// 会話ログにはコードや認証まわりの出力がそのまま入っているので、ループバック以外では待ち受けない
const HOST = '127.0.0.1';
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const HOOK_COMMAND = hookCommand({ port: PORT });
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
  // ターミナルの tmux の中で開いているセッションには、tmux のキー入力として送る（試験中）
  if (url.pathname === '/api/runner/send-tmux') {
    if (!text) return json(res, 400, { error: '送る内容が空です' });
    const other = openElsewhere(id);
    if (!other) return json(res, 409, { error: 'このセッションはもうターミナルで開かれていません。ページを読み直してください' });
    const out = await sendViaTmux(other, text);
    if (out.error) return json(res, out.code ?? 400, { error: out.error, screen: out.screen ?? null });
    return json(res, 200, { ...runnerState(id), elsewhere: other });
  }
  let out;
  if (url.pathname === '/api/runner/send') {
    if (!text) return json(res, 400, { error: '送る内容が空です' });
    out = send(id, cwd, text, s?.permissionMode, s?.title ? null : s?.firstPrompt ?? text);
  } else if (url.pathname === '/api/runner/answer') {
    out = answer(id, String(body.requestId ?? ''), body);
  } else if (url.pathname === '/api/runner/interrupt') {
    out = interrupt(id);
  } else {
    return json(res, 404, { error: 'not found' });
  }
  return out.error ? json(res, out.code ?? 400, { error: out.error }) : json(res, 200, out.state);
}

// Claude Code の PermissionRequest hook から届く。決まるまで応答を返さずに待つ
async function handleHook(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!checkHookToken(req.headers.authorization)) return json(res, 401, { error: 'unauthorized' });
  const payload = await readJson(req);
  const ac = new AbortController();
  // ターミナルのダイアログで先に答えると、Claude Code が hook を止めて接続が切れる
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  const decision = await review(payload, ac.signal);
  if (!ac.signal.aborted) json(res, 200, { decision });
}

async function handleReviews(req, res, url) {
  if (url.pathname === '/api/reviews') return json(res, 200, reviewState());
  if (url.pathname === '/api/reviews/decisions') return json(res, 200, decisionsFor(url.searchParams.get('session') ?? ''));
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'application/json only' });
  const body = await readJson(req);
  const out = answerReview(String(body.id ?? ''), body.behavior, body.message);
  return out.error ? json(res, out.code ?? 400, { error: out.error }) : json(res, 200, out.state);
}

// fs.watch は macOS のサンドボックス内で EMFILE になるなど環境によって使えないので、更新時刻を見に行く。
// 変わっていなければ 1,000 セッションほどで十数ミリ秒
const POLL_MS = 2000;
// ターミナルで答えた確認のカードを、次の確認のカードと並んで見えないうちに片付ける。セッションのファイルは数十個なので軽い
const REVIEW_SYNC_MS = 500;

function settingsBody() {
  return { ...getSettings(), claudeStatusCommand: claudeStatusCommand(), reviewConditions: CONDITIONS, hookCommand: HOOK_COMMAND };
}

// ステータスラインのコマンドはサーバーが動かすので、設定はブラウザではなくサーバー側に持つ
async function handleSettings(req, res) {
  if (req.method === 'GET') return json(res, 200, settingsBody());
  if (req.method !== 'POST') return json(res, 405, { error: 'GET or POST only' });
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'application/json only' });
  const body = await readJson(req);
  if (body.hideRules) {
    const out = setHideRules(body.hideRules);
    if (out.error) return json(res, 400, { error: out.error });
  }
  if (body.statusLine) {
    const out = setStatusLine(body.statusLine);
    if (out.error) return json(res, 400, { error: out.error });
    clearStatusCache();
  }
  if (body.review) {
    const out = setReview(body.review);
    if (out.error) return json(res, 400, { error: out.error });
  }
  return json(res, 200, settingsBody());
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
let others = JSON.stringify(otherStates());
const othersMessage = () => `event: others\ndata: ${others}\n\n`;
setInterval(() => {
  refresh();
  const next = JSON.stringify(otherStates());
  if (next !== others) {
    others = next;
    for (const res of listeners) res.write(othersMessage());
  }
  const { ids, replies } = takeChanges();
  if (!ids.length) return;
  const msg = `data: ${JSON.stringify({ ids, replies })}\n\n`;
  for (const res of listeners) res.write(msg);
}, POLL_MS);
setInterval(() => syncSessionStatuses(sessionStatuses()), REVIEW_SYNC_MS);
onRunnerChange((state) => {
  const msg = `event: runner\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of listeners) res.write(msg);
});
const reviewsMessage = (state) => `event: reviews\ndata: ${JSON.stringify(state)}\n\n`;
onReviewChange((state) => {
  const msg = reviewsMessage(state);
  for (const res of listeners) res.write(msg);
});

// よそのページに埋め込まれて「許可」を押させられないように、iframe への埋め込みを断る。
// script-src を自分のファイルだけにして、返答の HTML に属性を差し込まれてもスクリプトが動かないようにする。
// style-src の 'unsafe-inline' は、ANSI の色と表の列のそろえを style 属性で付けているため
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end('bad request');
  }
  // hook はブラウザではないので Origin を付けない。代わりにデータ用ディレクトリの合言葉を確かめる
  if (url.pathname === '/api/hook/permission-request') {
    try {
      return await handleHook(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
      return;
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !ALLOWED_ORIGINS.has(req.headers.origin ?? '')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    if (url.pathname === '/api/reviews' || url.pathname.startsWith('/api/reviews/')) return await handleReviews(req, res, url);
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
      res.write(othersMessage());
      res.write(reviewsMessage(reviewState()));
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
    if (url.pathname === '/api/hidden') {
      return json(res, 200, listHidden().map(({ id, at }) => {
        const s = getSession(id);
        return { id, at, title: s ? s.title || s.firstPrompt || null : null, end: s?.end ?? null, exists: !!s };
      }));
    }
    if (url.pathname === '/api/hide') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      const id = url.searchParams.get('id') ?? '';
      const on = url.searchParams.get('on') === '1';
      // 会話ログが消えたセッションも、隠した一覧から外せるようにする
      if (on && !getSession(id)) return json(res, 404, { error: 'not found' });
      return json(res, 200, { id, hidden: setHidden(id, on) });
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
// hook のスクリプトは合言葉のファイルが無いと何もせずに終わるので、最初の確認が届く前に作っておく
hookToken();
server.listen(PORT, HOST, () => console.log(`http://${HOST}:${PORT}/`));
// 1 回目は作業中・確認待ちのセッションが終わるのを待って止め、2 回目は待たずに止める
let closing = false;

function closeWhenIdle() {
  if (busyIds().length) return;
  stopAll();
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) {
      console.log('\n待たずに止めます');
      stopAll();
      process.exit(0);
    }
    closing = true;
    beginClosing();
    const ids = busyIds();
    if (!ids.length) closeWhenIdle();
    console.log(`\n作業中・確認待ちのセッションが ${ids.length} 件あります。終わったら止めます。すぐ止めるには、もう一度 Ctrl+C を押してください`);
    for (const id of ids) console.log(`  - ${getSession(id)?.title || getSession(id)?.firstPrompt?.slice(0, 60) || id}`);
    onRunnerChange(closeWhenIdle);
  });
}
// 別のプロセスグループで起動した claude が、サーバーだけ落ちたときに取り残されないようにする
process.on('exit', stopAll);
