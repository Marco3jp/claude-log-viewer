import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSettings } from './settings.js';
import { DATA_DIR } from './bookmarks.js';

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const TIMEOUT_MS = 3000;
const OUTPUT_MAX = 8 * 1024;
const CACHE_MS = 3000;
const LEARNED_FILE = path.join(DATA_DIR, 'statusline.json');

// 使用率とコンテキストの上限は会話ログに残らず、claude の出力にだけ流れてくるので、届いた値を覚えておく。
// 使用率はアカウント全体の値なので、どのセッションにも最後に届いた値を使う。
// サーバーを起動し直しても出せるように、データ用ディレクトリに残す
let learned = null;

function loadLearned() {
  if (learned) return learned;
  try {
    const v = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8'));
    learned = { rateLimits: v.rateLimits ?? null, contextWindows: v.contextWindows ?? {} };
  } catch {
    learned = { rateLimits: null, contextWindows: {} };
  }
  return learned;
}

function saveLearned() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 書き込み途中で落ちても壊れたファイルが残らないように、別名で書いてから置き換える
    const tmp = `${LEARNED_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(learned, null, 2));
    fs.renameSync(tmp, LEARNED_FILE);
  } catch {}
}

export function noteRateLimit(info) {
  const w = info?.unifiedWindows;
  if (!w) return;
  loadLearned().rateLimits = Object.fromEntries(Object.entries(w).map(([k, v]) => [k, {
    used_percentage: (v.utilization ?? 0) * 100,
    resets_at: v.resetsAt,
  }]));
  saveLearned();
}

export function noteModelUsage(modelUsage) {
  const l = loadLearned();
  let changed = false;
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    if (!u?.contextWindow || l.contextWindows[model] === u.contextWindow) continue;
    l.contextWindows[model] = u.contextWindow;
    changed = true;
  }
  if (changed) saveLearned();
}

// claude-opus-5-5 → Opus 5.5。形が違う ID はそのまま出す
function displayName(id) {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// Claude Code がステータスラインのコマンドに渡す JSON と同じ形にする。分からない項目は入れない
export function statusInput(s) {
  const u = s.usage;
  const total = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null;
  const { rateLimits, contextWindows } = loadLearned();
  const size = contextWindows[s.model];
  const c = s.cost;
  return {
    hook_event_name: 'Status',
    session_id: s.id,
    transcript_path: s.file,
    cwd: s.cwd,
    model: s.model ? { id: s.model, display_name: displayName(s.model) } : undefined,
    workspace: { current_dir: s.cwd, project_dir: s.cwd },
    version: s.version ?? undefined,
    effort: s.effort ? { level: s.effort } : undefined,
    cost: c ? {
      total_cost_usd: c.totalCostUSD,
      total_duration_ms: c.totalDuration,
      total_api_duration_ms: c.totalAPIDuration,
      total_lines_added: c.totalLinesAdded,
      total_lines_removed: c.totalLinesRemoved,
    } : undefined,
    // 上限が分からないまま使用量だけ渡すと、コマンド側の既定の上限で割られて誤った割合になる
    context_window: total != null && size ? { total_input_tokens: total, context_window_size: size, used_percentage: (total / size) * 100 } : undefined,
    prompt_cache: total ? { hit_ratio: (u.cache_read_input_tokens ?? 0) / total } : undefined,
    rate_limits: rateLimits ?? undefined,
  };
}

export function claudeStatusCommand() {
  try {
    const st = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).statusLine;
    return st?.type === 'command' && st.command ? st.command : null;
  } catch {
    return null;
  }
}

function run(command, cwd, input) {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], { cwd, stdio: ['pipe', 'pipe', 'ignore'], timeout: TIMEOUT_MS });
    let out = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { if (out.length < OUTPUT_MAX) out += d; });
    proc.on('error', () => resolve(null));
    proc.on('close', () => resolve(out.slice(0, OUTPUT_MAX)));
    proc.stdin.on('error', () => {});
    proc.stdin.end(JSON.stringify(input));
  });
}

const cache = new Map();

export function clearStatusCache() {
  cache.clear();
}

// 設定で選んだ出し方に合わせる。claude は Claude Code の statusLine、command はビュワー専用のコマンド
export async function renderStatus(s) {
  const hit = cache.get(s.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const { mode, command: own } = getSettings().statusLine;
  const input = statusInput(s);
  const command = mode === 'claude' ? claudeStatusCommand() : mode === 'command' ? own : null;
  const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
  const text = command ? await run(command, cwd, input) : null;
  const value = { mode, text, input, command: !!command };
  cache.set(s.id, { at: Date.now(), value });
  return value;
}
