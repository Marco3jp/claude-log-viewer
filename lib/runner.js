import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { noteRateLimit, noteModelUsage } from './statusline.js';
import { noteCommands } from './suggest.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
// 返事を待つ間は会話の続きを速く返せるようにプロセスを残し、しばらく使われなければ止める
const IDLE_MS = 10 * 60 * 1000;
const STDERR_KEEP = 4000;
const TITLE_SOURCE_MAX = 1000;
// 全部の確認を飛ばすモードはブラウザからの起動では引き継がず、確認を出すモードで動かす
const MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'plan']);

// --permission-prompt-tool stdio を付けると、許可確認と AskUserQuestion が can_use_tool の問い合わせとして標準出力に届く
const ARGS = [
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio',
];

const runners = new Map();
const listeners = new Set();
// こちらから送った問い合わせ（巻き戻しなど）の答えを待つもの。request_id → resolve
const pendingControls = new Map();
// AI が判定して人に回した確認の、判定の記録。答えたときに記録に足す
const reviewItems = new Map();
let reviewer = null;

// 許可の確認を AI で判定する仕組み（lib/review.js）。review.js がこのファイルを読むので、server.js からつなぐ
export function setReviewer(r) {
  reviewer = r;
}

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

// Claude Code が動いている間 ~/.claude/sessions に置くファイルのうち、ビュワーが起動したもの以外
function otherProcesses() {
  const own = new Set([...runners.values()].map((r) => r.proc?.pid).filter(Boolean));
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    if (!info.sessionId || own.has(info.pid) || !alive(info.pid)) continue;
    out.push(info);
  }
  return out;
}

// ターミナルなどで同じセッションが動いていると、2 つのプロセスが同じ会話ログに書き込むことになる
export function openElsewhere(id) {
  const info = otherProcesses().find((x) => x.sessionId === id);
  return info ? { pid: info.pid, kind: info.kind ?? null, name: info.name ?? null, tmux: info.tmux ?? null } : null;
}

// ターミナルなどで動いているセッションの状態。Claude Code はそのファイルの status に busy・waiting・idle を書く
export function otherStates() {
  const out = {};
  for (const info of otherProcesses()) {
    if (info.status !== 'busy' && info.status !== 'waiting') continue;
    out[info.sessionId] = { status: info.status, waitingFor: info.waitingFor ?? null };
  }
  return out;
}

// 確認待ちのダイアログが出ている間、Claude Code はそのセッションのファイルの status を waiting にする
export function sessionStatuses() {
  const out = new Map();
  for (const info of otherProcesses()) out.set(info.sessionId, { status: info.status ?? null, statusUpdatedAt: info.statusUpdatedAt ?? 0 });
  return out;
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
  if (m.type === 'control_response' && m.response?.request_id?.startsWith('init-')) {
    noteCommands(r.cwd, m.response.response?.commands);
  } else if (m.type === 'control_response' && pendingControls.has(m.response?.request_id)) {
    pendingControls.get(m.response.request_id)(m.response);
  } else if (m.type === 'control_request' && m.request?.subtype === 'can_use_tool') {
    const q = m.request;
    const p = {
      requestId: m.request_id,
      toolName: q.tool_name,
      input: q.input ?? {},
      interactive: !!q.requires_user_interaction,
      status: 'waiting',
    };
    r.pending.set(m.request_id, p);
    if (reviewer && !p.interactive) checkPermission(r, p);
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

// hook から届く確認と同じ条件で判定し、当たらなければ人に聞かずに許可する。判定している間もカードは出して、人が先に答えられるようにする
function checkPermission(r, p) {
  const check = reviewer.check({ sessionId: r.id, toolName: p.toolName, input: p.input, cwd: r.cwd });
  if (!check) return;
  p.status = 'analyzing';
  check.then((res) => {
    if (r.pending.get(p.requestId) !== p) return;
    if (!res) {
      p.status = 'waiting';
    } else if (res.allow) {
      write(r, { type: 'control_response', response: { subtype: 'success', request_id: p.requestId, response: { behavior: 'allow', updatedInput: p.input } } });
      r.pending.delete(p.requestId);
    } else {
      Object.assign(p, { status: 'waiting', analysis: res.analysis, hold: res.hold, level: res.level });
      reviewItems.set(p.requestId, res.item);
    }
    changed(r);
  }, () => {
    if (r.pending.get(p.requestId) !== p) return;
    p.status = 'waiting';
    changed(r);
  });
}

// claude に問い合わせを送って、答えを待つ
function control(r, request, timeoutMs = 30000) {
  const requestId = `${request.subtype}-${randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => done({ subtype: 'error', error: '答えが返ってきませんでした' }), timeoutMs);
    const onClose = () => done({ subtype: 'error', error: 'claude が終了しました' });
    function done(response) {
      clearTimeout(timer);
      pendingControls.delete(requestId);
      r.proc?.off('close', onClose);
      resolve(response.subtype === 'success' ? { response: response.response ?? {} } : { error: response.error ?? '問い合わせに失敗しました' });
    }
    pendingControls.set(requestId, done);
    r.proc.once('close', onClose);
    write(r, { type: 'control_request', request_id: requestId, request });
  });
}

function start(id, cwd, permissionMode, { fresh = false } = {}) {
  const mode = MODES.has(permissionMode) ? permissionMode : null;
  const args = [...ARGS, ...(mode ? ['--permission-mode', mode] : []), fresh ? '--session-id' : '--resume', id];
  // ターミナルの Ctrl+C はプロセスグループ全体に届くので、サーバーが作業の終わりを待てるように別のグループで起動する
  // ファイルの記録を取らせて、巻き戻すときにファイルも戻せるようにする。ターミナルの claude は既定で取っている
  const env = { ...process.env, CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' };
  const proc = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
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
  // SDK と同じく最初に initialize を送る。返ってくるコマンドの一覧を、入力欄の / の候補に使う
  write(r, { type: 'control_request', request_id: `init-${randomUUID()}`, request: { subtype: 'initialize' } });
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

// 対話モードの claude は最初のプロンプトからタイトルを作るが、-p では作らないので頼む。
// persist を付けると claude が会話ログに ai-title として書き、もうタイトルがあればそれを返すだけになる
function requestTitle(r, description) {
  if (r.titleRequested || !description) return;
  r.titleRequested = true;
  write(r, {
    type: 'control_request',
    request_id: `title-${randomUUID()}`,
    request: { subtype: 'generate_session_title', description: description.slice(0, TITLE_SOURCE_MAX), persist: true },
  });
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
  const r = start(randomUUID(), cwd, permissionMode, { fresh: true });
  const out = post(r, text);
  requestTitle(r, text);
  return out;
}

// titleSource はタイトルの無いセッションのときだけ渡す
// 作業していないプロセスを返す。無ければ起動する。what は断るときの文に使う（「送って」「巻き戻して」など）
function idleRunner(id, cwd, permissionMode, what) {
  if (closing) return { error: `サーバーを止めるところなので、${what}られません`, code: 503 };
  const r = runners.get(id);
  if (r?.proc && (r.busy || r.pending.size)) return { error: `Claude が作業中です。終わってから${what}ください`, code: 409 };
  if (r?.proc) return { r };
  const other = openElsewhere(id);
  if (other) {
    return { error: `このセッションは別のプロセス（PID ${other.pid}${other.kind ? `・${other.kind}` : ''}）で開かれています。そちらを閉じてから${what}ください`, code: 409 };
  }
  if (!cwd || !fs.existsSync(cwd)) return { error: `作業ディレクトリが見つかりません: ${cwd ?? '(不明)'}`, code: 400 };
  return { r: start(id, cwd, permissionMode) };
}

// titleSource はタイトルの無いセッションのときだけ渡す
export function send(id, cwd, text, permissionMode, titleSource) {
  const { r, ...err } = idleRunner(id, cwd, permissionMode, '送って');
  if (!r) return err;
  const out = post(r, text);
  requestTitle(r, titleSource);
  return out;
}

const REWIND_ERRORS = {
  'File rewinding is not enabled.': 'このセッションはファイルの記録を取っていません',
  'No file checkpoint found for this message.': 'この発言の時点のファイルの記録がありません',
};

// Claude Code の巻き戻しと同じく、target の発言より前に会話を戻す。会話ログは消えず、次の発言がそこから枝分かれする。
// files を付けると、ファイルもその発言の時点に戻す。dryRun ではファイルの変わり方だけを調べて、何も変えない
export async function rewind(id, cwd, permissionMode, { target, lastSeen, files = false, dryRun = false }) {
  const { r, ...err } = idleRunner(id, cwd, permissionMode, '巻き戻して');
  if (!r) return err;
  armIdle(r);
  changed(r);
  let fileInfo = null;
  if (dryRun || files) {
    const f = await control(r, { subtype: 'rewind_files', user_message_id: target, dry_run: dryRun });
    fileInfo = f.error ? { canRewind: false, error: f.error } : f.response;
    if (fileInfo.error) fileInfo.error = REWIND_ERRORS[fileInfo.error] ?? fileInfo.error;
  }
  if (dryRun) return { files: fileInfo };
  if (files && !fileInfo.canRewind) return { error: `ファイルを戻せませんでした: ${fileInfo.error ?? '理由が分かりません'}`, code: 409 };
  const c = await control(r, { subtype: 'rewind_conversation', target_message_uuid: target, last_seen_user_message_uuid: lastSeen });
  const res = c.response ?? {};
  if (c.error || !res.rewound) {
    const reason = c.error ?? res.error ?? res.reason ?? '理由が分かりません';
    return { error: `${files ? 'ファイルは戻しましたが、' : ''}会話を巻き戻せませんでした: ${reason}`, code: 409 };
  }
  return { rewound: true, prefillText: res.prefillText ?? '', files: files ? fileInfo : null };
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
  // AI が判定して人に回したものは、答えも判定の記録に残す
  const item = reviewItems.get(requestId);
  if (item) {
    reviewItems.delete(requestId);
    reviewer?.record(item, behavior === 'allow', response.message);
  }
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
