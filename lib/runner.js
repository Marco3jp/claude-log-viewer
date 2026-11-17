import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { noteRateLimit, noteModelUsage } from './statusline.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
// 返事を待つ間は会話の続きを速く返せるようにプロセスを残し、しばらく使われなければ止める
const IDLE_MS = 10 * 60 * 1000;
const STDERR_KEEP = 4000;
// 全部の確認を飛ばすモードはブラウザからの起動では引き継がず、確認を出すモードで動かす
const MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'plan']);

// --permission-prompt-tool stdio を付けると、許可確認と AskUserQuestion が can_use_tool の問い合わせとして標準出力に届く
const ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio',
];

const runners = new Map();
const listeners = new Set();

export function onRunnerChange(fn) {
  listeners.add(fn);
}

function snapshot(r) {
  return {
    id: r.id,
    alive: !!r.proc,
    running: r.busy,
    mode: r.mode,
    pending: [...r.pending.values()],
    error: r.error,
  };
}

function changed(r) {
  const s = snapshot(r);
  for (const fn of listeners) fn(s);
}

export function runnerState(id) {
  const r = runners.get(id);
  return r ? snapshot(r) : { id, alive: false, running: false, mode: null, pending: [], error: null };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ターミナルなどで同じセッションが動いていると、2 つのプロセスが同じ会話ログに書き込むことになる
export function openElsewhere(id) {
  const own = new Set([...runners.values()].map((r) => r.proc?.pid).filter(Boolean));
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  for (const f of files) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (info.sessionId !== id || own.has(info.pid) || !alive(info.pid)) continue;
    return { pid: info.pid, kind: info.kind ?? null, name: info.name ?? null, tmux: info.tmux ?? null };
  }
  return null;
}

function write(r, obj) {
  r.proc.stdin.write(`${JSON.stringify(obj)}\n`);
}

function armIdle(r) {
  clearTimeout(r.idle);
  if (r.busy || r.pending.size) return;
  r.idle = setTimeout(() => r.proc?.kill(), IDLE_MS);
}

function onMessage(r, m) {
  if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
    const q = m.request;
    r.pending.set(m.request_id, {
      requestId: m.request_id,
      toolName: q.tool_name,
      input: q.input ?? {},
      interactive: !!q.requires_user_interaction,
    });
    changed(r);
  } else if (m.type === 'control_request') {
    // 問い合わせに答えないと claude 側が待ち続けるので、扱わない種類はエラーで返す
    write(r, { type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `${m.request?.subtype} はビュワーでは扱えません` } });
  } else if (m.type === 'control_cancel_request') {
    if (r.pending.delete(m.request_id)) changed(r);
  } else if (m.type === 'rate_limit_event') {
    noteRateLimit(m.rate_limit_info);
  } else if (m.type === 'result') {
    noteModelUsage(m.modelUsage);
    r.busy = false;
    // その回が終われば、答えていない確認も締め切られている
    r.pending.clear();
    // 割り込んだ回はエラーとして終わるが、こちらが止めたものなので出さない
    r.error = m.is_error && !r.interrupting ? String(m.result || m.subtype || 'エラーで終わりました') : null;
    r.interrupting = false;
    armIdle(r);
    changed(r);
  }
}

function start(id, cwd, permissionMode, { fresh = false } = {}) {
  const mode = MODES.has(permissionMode) ? permissionMode : null;
  const args = [...ARGS, ...(mode ? ['--permission-mode', mode] : []), fresh ? '--session-id' : '--resume', id];
  // ターミナルの Ctrl+C はプロセスグループ全体に届くので、サーバーが作業の終わりを待てるように別のグループで起動する
  const proc = spawn(CLAUDE_BIN, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const r = { id, cwd, proc, mode: mode ?? 'default', busy: false, pending: new Map(), error: null, stderr: '', idle: null, interrupting: false };
  runners.set(id, r);

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(r, m);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => { r.stderr = (r.stderr + d).slice(-STDERR_KEEP); });
  proc.stdin.on('error', () => {});
  proc.on('error', (e) => {
    r.error = `${CLAUDE_BIN} を起動できませんでした: ${e.message}`;
    r.proc = null;
    r.busy = false;
    r.pending.clear();
    changed(r);
  });
  proc.on('close', (code, signal) => {
    clearTimeout(r.idle);
    if (!r.error && (r.busy || code)) {
      r.error = `claude が終了しました（${signal ?? `終了コード ${code}`}）${r.stderr.trim() ? `\n${r.stderr.trim()}` : ''}`;
    }
    r.proc = null;
    r.busy = false;
    r.pending.clear();
    changed(r);
  });
  return r;
}

// 新しいセッションは会話ログが書かれるまで一覧に無いので、ビュワーが起動したものはここで覚えている
export function runnerCwd(id) {
  return runners.get(id)?.cwd ?? null;
}

function post(r, text) {
  clearTimeout(r.idle);
  r.busy = true;
  r.error = null;
  write(r, { type: 'user', message: { role: 'user', content: text } });
  changed(r);
  return { state: snapshot(r) };
}

let closing = false;

// サーバーを止めるところなので、これ以上作業を始めない
export function beginClosing() {
  closing = true;
}

export function busyIds() {
  return [...runners.values()].filter((r) => r.proc && (r.busy || r.pending.size)).map((r) => r.id);
}

export function create(cwd, text, permissionMode) {
  if (closing) return { error: 'サーバーを止めるところなので、新しく始められません', code: 503 };
  if (!cwd || !path.isAbsolute(cwd)) return { error: '作業ディレクトリは絶対パスで書いてください', code: 400 };
  let st;
  try {
    st = fs.statSync(cwd);
  } catch {
    return { error: `作業ディレクトリが見つかりません: ${cwd}`, code: 400 };
  }
  if (!st.isDirectory()) return { error: `ディレクトリではありません: ${cwd}`, code: 400 };
  return post(start(randomUUID(), cwd, permissionMode, { fresh: true }), text);
}

export function send(id, cwd, text, permissionMode) {
  if (closing) return { error: 'サーバーを止めるところなので、送れません', code: 503 };
  let r = runners.get(id);
  if (r?.proc && (r.busy || r.pending.size)) return { error: 'Claude が作業中です。終わってから送ってください', code: 409 };
  if (!r?.proc) {
    const other = openElsewhere(id);
    if (other) {
      return { error: `このセッションは別のプロセス（PID ${other.pid}${other.kind ? `・${other.kind}` : ''}）で開かれています。そちらを閉じてから送ってください`, code: 409 };
    }
    if (!cwd || !fs.existsSync(cwd)) return { error: `作業ディレクトリが見つかりません: ${cwd ?? '(不明)'}`, code: 400 };
    r = start(id, cwd, permissionMode);
  }
  return post(r, text);
}

// 入力はブラウザから受け取らず、claude から届いたものを使う。AskUserQuestion だけ答えを足す
export function answer(id, requestId, { behavior, answers, message }) {
  const r = runners.get(id);
  const p = r?.pending.get(requestId);
  if (!r?.proc || !p) return { error: 'この確認はもう締め切られています', code: 404 };
  let response;
  if (behavior === 'allow') {
    const updatedInput = answers && typeof answers === 'object' ? { ...p.input, answers } : p.input;
    response = { behavior: 'allow', updatedInput };
  } else {
    response = { behavior: 'deny', message: message || 'ビュワーから拒否されました' };
  }
  write(r, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  r.pending.delete(requestId);
  changed(r);
  return { state: snapshot(r) };
}

// Claude Code で作業中に Esc を押したときと同じく、その回の作業だけを打ち切る。プロセスと会話はそのまま残る
export function interrupt(id) {
  const r = runners.get(id);
  if (!r?.proc || !(r.busy || r.pending.size)) return { error: '止める作業がありません', code: 409 };
  r.interrupting = true;
  write(r, { type: 'control_request', request_id: `interrupt-${randomUUID()}`, request: { subtype: 'interrupt' } });
  return { state: snapshot(r) };
}

export function stopAll() {
  for (const r of runners.values()) r.proc?.kill();
}
