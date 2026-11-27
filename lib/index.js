import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readJsonl, textOf, toolCategory, mcpServer, fileAccess, findRefs, promptText, stripReminders,
} from './parse.js';
import { repoOf } from './repo.js';
import { isBookmarked } from './bookmarks.js';
import { isHidden } from './hidden.js';
import { getTitle } from './titles.js';
import { getSettings } from './settings.js';
import { agentStub, agentDetail, isRunning } from './agents.js';

export const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');

// 検索用に持つツール結果の長さ。全文を持つとメモリが膨らむので頭だけ
const RESULT_INDEX_CHARS = 4000;

const sessions = new Map();

function subagentFiles(sessionFile) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function fingerprint(files) {
  return files.map((f) => {
    try {
      const st = fs.statSync(f);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'x';
    }
  }).join(',');
}

function summarize(file, project) {
  const id = path.basename(file, '.jsonl');
  const subs = subagentFiles(file);
  const s = {
    id, file, project,
    title: null, customTitle: null, aiTitle: null, firstPrompt: null, lastPrompt: null,
    lastCwd: null, cwds: new Set(), branches: new Set(), repos: new Set(), refs: new Set(), createdRefs: new Set(), promptRefs: new Set(),
    tools: new Map(), mcp: new Map(),
    reads: new Set(), writes: new Set(),
    start: null, end: null, prompts: 0, turns: 0, bash: 0, subagents: subs.length, permissionMode: null, viewerMode: null,
    model: null, effort: null, version: null, usage: null, cost: null, lastReply: null,
    agents: subs.map(agentStub), agentResults: new Set(),
    text: '', lower: '',
  };
  const chunks = [];
  const toolCmd = new Map();

  const handle = (r, isSub) => {
    if (r.type === 'ai-title' && r.aiTitle) s.aiTitle = r.aiTitle;
    if (r.type === 'custom-title' && r.customTitle) s.customTitle = r.customTitle;
    if (r.type === 'cost-state' && !isSub) s.cost = r;
    // Claude Code はこのセッションで作った PR を pr-link として書く
    if (r.type === 'pr-link' && r.prUrl) {
      findRefs(r.prUrl, null, s.refs);
      findRefs(r.prUrl, null, s.createdRefs);
    }
    if (r.timestamp) {
      if (!s.start || r.timestamp < s.start) s.start = r.timestamp;
      if (!s.end || r.timestamp > s.end) s.end = r.timestamp;
    }
    if (r.cwd) {
      s.cwds.add(r.cwd);
      // Bash の cd で作業ディレクトリが移ると、それ以降の行の cwd が変わる
      if (!isSub) s.lastCwd = r.cwd;
      const repo = repoOf(r.cwd);
      if (repo) s.repos.add(repo);
    }
    if (r.gitBranch && r.gitBranch !== 'HEAD') s.branches.add(r.gitBranch);
    const ghRepo = r.cwd ? repoOf(r.cwd) : null;
    const defaultRepo = ghRepo && !ghRepo.startsWith('local:') ? ghRepo : null;
    const c = r.message?.content;
    if (r.type === 'user') {
      // ターミナルで最後に使っていたモードを優先し、ビュワーで始めたセッションはビュワーで使ったモードを使う
      if (!isSub && r.permissionMode) s[r.entrypoint === 'sdk-cli' ? 'viewerMode' : 'permissionMode'] = r.permissionMode;
      const p = isSub ? null : promptText(r);
      if (p) {
        s.prompts++;
        if (!s.firstPrompt) {
          s.firstPrompt = p.slice(0, 300);
          findRefs(p, defaultRepo, s.promptRefs);
        }
        s.lastPrompt = p.slice(0, 300);
        chunks.push(p);
        findRefs(p, defaultRepo, s.refs);
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const t = typeof b.content === 'string' ? b.content : textOf(b.content);
          chunks.push(t.slice(0, RESULT_INDEX_CHARS));
          // 結果が返った Agent の呼び出しは終わっている。バックグラウンドで起動しただけのものは除く
          const tur = r.toolUseResult;
          if (!isSub && !(tur && typeof tur === 'object' && tur.status === 'async_launched')) s.agentResults.add(b.tool_use_id);
          // 作成した Issue・PR の URL は結果側にしか出ない
          const cmd = toolCmd.get(b.tool_use_id);
          if (cmd && /\bgh\s+(issue|pr)\s+create\b/.test(cmd)) {
            findRefs(t, defaultRepo, s.refs);
            findRefs(t, defaultRepo, s.createdRefs);
          }
        }
      }
    } else if (r.type === 'assistant' && Array.isArray(c)) {
      if (!isSub) {
        s.turns++;
        const m = r.message;
        if (m.model && m.model !== '<synthetic>') s.model = m.model;
        if (r.effort) s.effort = r.effort;
        if (r.version) s.version = r.version;
        if (m.usage) s.usage = m.usage;
        // 返事を書き終えた行。一覧の未読と通知に使う
        const text = c.find((b) => b.type === 'text')?.text;
        if (m.stop_reason === 'end_turn' && text) s.lastReply = { uuid: r.uuid, ts: r.timestamp, text: text.slice(0, 300) };
      }
      for (const b of c) {
        if (b.type === 'text') {
          chunks.push(b.text);
          findRefs(b.text, defaultRepo, s.refs);
        } else if (b.type === 'thinking' && b.thinking) {
          chunks.push(b.thinking);
        } else if (b.type === 'tool_use') {
          const name = b.name;
          s.tools.set(name, (s.tools.get(name) ?? 0) + 1);
          const cat = toolCategory(name);
          if (cat === 'mcp') {
            const srv = mcpServer(name);
            s.mcp.set(srv, (s.mcp.get(srv) ?? 0) + 1);
          }
          const input = b.input ?? {};
          if (name === 'Bash') {
            s.bash++;
            toolCmd.set(b.id, input.command ?? '');
          }
          const fa = fileAccess(name, input, r.cwd);
          if (fa) (fa.mode === 'write' ? s.writes : s.reads).add(fa.path);
          const inputText = JSON.stringify(input);
          chunks.push(`${name} ${inputText}`);
          findRefs(inputText.replace(/\\n/g, '\n'), defaultRepo, s.refs);
        }
      }
    }
  };

  for (const r of readJsonl(file)) handle(r, false);
  for (const f of subs) for (const r of readJsonl(f)) handle(r, true);

  if (!s.start || (s.prompts === 0 && s.turns === 0)) return null;
  // ビュワーで付けたタイトル、/rename や --name で付けたタイトル（custom-title）、AI が付けたものの順に使う
  const viewerTitle = getTitle(s.id);
  s.title = viewerTitle ?? s.customTitle ?? s.aiTitle;
  s.titleBy = viewerTitle ? 'viewer' : s.customTitle ? 'custom' : s.aiTitle ? 'ai' : null;
  s.text = [s.title ?? '', ...chunks].join('\n\u0000');
  s.lower = s.text.toLowerCase();
  s.cwd = [...s.cwds][0] ?? null;
  s.permissionMode ??= s.viewerMode;
  return s;
}

// 一覧の検索などから呼ばれた refresh で見つけた変更も、通知のときにまとめて渡せるようにためておく
const pending = { ids: new Set(), replies: new Map() };
let loaded = false;

export function takeChanges() {
  const out = { ids: [...pending.ids], replies: [...pending.replies.values()] };
  pending.ids.clear();
  pending.replies.clear();
  return out;
}

// 読み直した・消えたセッションの id を返す
export function refresh() {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const changed = [];
  const seen = new Set();
  for (const d of dirs) {
    const pdir = path.join(PROJECTS_DIR, d.name);
    let files;
    try {
      files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(pdir, f);
      seen.add(file);
      const fp = fingerprint([file, ...subagentFiles(file)]);
      const cur = sessions.get(file);
      if (cur && cur.fp === fp) continue;
      // 1 ファイルの読めない行で、ほかのセッションの読み込みやサーバーごと止めない
      let s = null;
      try {
        s = summarize(file, d.name);
      } catch (e) {
        console.error(`${file} を読めませんでした:`, e);
      }
      sessions.set(file, { fp, s });
      changed.push(path.basename(file, '.jsonl'));
      pending.ids.add(path.basename(file, '.jsonl'));
      // 隠したセッションはミュートとして扱い、返事が来ても通知しない
      if (loaded && s?.lastReply && s.lastReply.uuid !== cur?.s?.lastReply?.uuid && !hiddenBy(s, hideRules())) {
        pending.replies.set(s.id, { id: s.id, title: s.title || s.firstPrompt || s.id, reply: s.lastReply });
      }
    }
  }
  for (const k of sessions.keys()) {
    if (seen.has(k)) continue;
    sessions.delete(k);
    changed.push(path.basename(k, '.jsonl'));
    pending.ids.add(path.basename(k, '.jsonl'));
  }
  loaded = true;
  return changed;
}

// 会話ログが変わっていなくても、次の refresh で読み直させる。ビュワーで付けたタイトルを検索や一覧に反映するときに使う
export function invalidate(id) {
  for (const v of sessions.values()) if (v.s?.id === id) v.fp = null;
}

const TITLE_SOURCE_MAX = 12000;

// タイトルを付け直すときにモデルへ渡す、ユーザーの発言と Claude の返事。長いときは最初の依頼と後ろのほうを残す
export function titleSource(id) {
  const s = getSession(id);
  if (!s) return null;
  const items = [];
  for (const r of readJsonl(s.file)) {
    const p = promptText(r);
    if (p) items.push(`ユーザー: ${p.slice(0, items.length ? 600 : 3000)}`);
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) if (b.type === 'text' && b.text.trim()) items.push(`Claude: ${b.text.slice(0, 600)}`);
    }
  }
  const [first, ...rest] = items;
  const tail = [];
  let size = first?.length ?? 0;
  for (let i = rest.length - 1; i >= 0 && size + rest[i].length <= TITLE_SOURCE_MAX; i--) {
    tail.unshift(rest[i]);
    size += rest[i].length;
  }
  return [first, ...tail].filter(Boolean).join('\n\n');
}

export function isSessionHidden(id) {
  const s = getSession(id);
  return !!(s && hiddenBy(s, hideRules()));
}

export function getSession(id) {
  for (const { s } of sessions.values()) if (s && s.id === id) return s;
  return null;
}

function parseQuery(q) {
  const include = [];
  const exclude = [];
  for (const m of (q ?? '').matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const neg = m[1] || m[3];
    const term = (m[2] ?? m[4]).toLowerCase();
    if (!term || term === '-') continue;
    (neg ? exclude : include).push(term);
  }
  return { include, exclude };
}

function snippet(s, terms) {
  for (const t of terms) {
    const i = s.lower.indexOf(t);
    if (i < 0) continue;
    const a = Math.max(0, i - 60);
    const b = Math.min(s.text.length, i + t.length + 100);
    return (a > 0 ? '…' : '') + s.text.slice(a, b).replace(/\u0000/g, ' ').replace(/\s+/g, ' ') + (b < s.text.length ? '…' : '');
  }
  return null;
}

function countHits(lower, term) {
  let n = 0;
  let i = lower.indexOf(term);
  while (i >= 0 && n < 999) {
    n++;
    i = lower.indexOf(term, i + term.length);
  }
  return n;
}

const all = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).filter(Boolean);

function matches(s, f, q) {
  if (f.bm && !isBookmarked(s.id)) return false;
  for (const p of all(f.project)) if (s.project !== p) return false;
  for (const r of all(f.repo)) if (!s.repos.has(r)) return false;
  for (const r of all(f.ref)) if (![...s.refs].some((x) => x.startsWith(`${r}|`))) return false;
  for (const t of all(f.tool)) if (!s.tools.has(t)) return false;
  for (const m of all(f.mcp)) if (!s.mcp.has(m)) return false;
  for (const b of all(f.branch)) if (!s.branches.has(b)) return false;
  for (const p of all(f.path)) {
    const mode = f.pathMode ?? 'any';
    const pool = mode === 'read' ? [s.reads] : mode === 'write' ? [s.writes] : [s.reads, s.writes];
    if (!pool.some((set) => [...set].some((x) => x.includes(p)))) return false;
  }
  if (f.from && s.end < f.from) return false;
  if (f.to && s.start > `${f.to}T23:59:59.999Z`) return false;
  for (const t of q.include) if (!s.lower.includes(t)) return false;
  for (const t of q.exclude) if (s.lower.includes(t)) return false;
  return true;
}

function topCounts(list, key, limit = 40) {
  const m = new Map();
  for (const s of list) for (const v of key(s)) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

// 一覧の右のボタンで隠したものは manual、返答が無いものは empty、設定の文字列に当たったものは rule
function hiddenBy(s, rules) {
  if (isHidden(s.id)) return 'manual';
  if (rules.empty && s.turns === 0) return 'empty';
  if (rules.title.length) {
    const title = (s.title || s.firstPrompt || '').toLowerCase();
    if (rules.title.some((t) => title.includes(t))) return 'rule';
  }
  if (rules.text.some((t) => s.lower.includes(t))) return 'rule';
  if (rules.dirs.length && s.cwd) {
    const cwd = normalizeDir(s.cwd);
    if (rules.dirs.some((d) => cwd === d || cwd.startsWith(`${d}/`))) return 'rule';
  }
  return null;
}

// macOS の /var・/tmp・/etc は /private の下への別名なので、どちらで書いても同じ場所として比べる
function normalizeDir(p) {
  const abs = p.replace(/^~(?=\/|$)/, os.homedir()).replace(/\/+$/, '') || '/';
  return abs.replace(/^\/private(?=\/(var|tmp|etc)(\/|$))/, '');
}

function hideRules() {
  const { title, text, dirs = [], empty } = getSettings().hideRules;
  return { title: title.map((t) => t.toLowerCase()), text: text.map((t) => t.toLowerCase()), dirs: dirs.map(normalizeDir), empty };
}

function brief(s, q, rules) {
  // このセッションで出したもの、最初のプロンプトにあったもの、それ以外の順に並べる
  const role = (x) => (s.createdRefs.has(x) ? 'created' : s.promptRefs.has(x) ? 'prompt' : null);
  const order = { created: 0, prompt: 1 };
  const refs = [...s.refs].map((x) => {
    const [ref, kind] = x.split('|');
    return { ref, kind, role: role(x) };
  }).sort((a, b) => (order[a.role] ?? 2) - (order[b.role] ?? 2));
  return {
    id: s.id,
    bookmarked: isBookmarked(s.id),
    hidden: hiddenBy(s, rules),
    project: s.project,
    title: s.title,
    titleBy: s.titleBy,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    cwd: s.cwd,
    lastCwd: s.lastCwd,
    repos: [...s.repos],
    branches: [...s.branches],
    refs,
    start: s.start,
    end: s.end,
    prompts: s.prompts,
    turns: s.turns,
    bash: s.bash,
    subagents: s.subagents,
    agentsRunning: s.agents.filter((a) => isRunning(a, s.agentResults)).length,
    permissionMode: s.permissionMode,
    lastReply: s.lastReply,
    tools: Object.fromEntries(s.tools),
    reads: s.reads.size,
    writes: s.writes.size,
    snippet: q.include.length ? snippet(s, q.include) : null,
    hits: q.include.length ? countHits(s.lower, q.include[0]) : null,
  };
}

// ディレクトリ名は "/" を "-" に置き換えただけで元に戻せないので、実際の cwd から表示名を作る
function projectLabels() {
  const home = os.homedir();
  const out = {};
  for (const { s } of sessions.values()) {
    if (!s) continue;
    for (const cwd of s.cwds) {
      if (cwd.replace(/[^A-Za-z0-9]/g, '-') !== s.project) continue;
      out[s.project] = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
    }
  }
  return out;
}

export function search(f) {
  refresh();
  const q = parseQuery(f.q);
  let list = [...sessions.values()].map((x) => x.s).filter((s) => s && matches(s, f, q));
  const rules = hideRules();
  let hiddenEmpty = 0;
  let hiddenByUser = 0;
  if (!f.hidden) {
    list = list.filter((s) => {
      const by = hiddenBy(s, rules);
      if (by === 'empty') hiddenEmpty++;
      else if (by) hiddenByUser++;
      return !by;
    });
  }
  if (f.sort === 'hits' && q.include.length) {
    list.sort((a, b) => countHits(b.lower, q.include[0]) - countHits(a.lower, q.include[0]));
  } else if (f.sort === 'start') {
    list.sort((a, b) => (a.start < b.start ? 1 : -1));
  } else {
    list.sort((a, b) => (a.end < b.end ? 1 : -1));
  }
  // ブックマークしたものは、並び順によらず上に固める。sort は安定なので、その中の順は上で決めた並びのまま
  list.sort((a, b) => Number(isBookmarked(b.id)) - Number(isBookmarked(a.id)));
  const limit = Math.min(Number(f.limit) || 200, 1000);
  return {
    total: list.length,
    hiddenEmpty,
    hiddenByUser,
    indexed: sessions.size,
    projectLabels: projectLabels(),
    sessions: list.slice(0, limit).map((s) => brief(s, q, rules)),
    facets: {
      project: topCounts(list, (s) => [s.project]),
      repo: topCounts(list, (s) => s.repos),
      ref: topCounts(list, (s) => [...s.refs].map((x) => x.split('|')[0]), 60),
      tool: topCounts(list, (s) => [...s.tools.keys()].filter((t) => !t.startsWith('mcp__')), 40),
      mcp: topCounts(list, (s) => s.mcp.keys()),
      branch: topCounts(list, (s) => s.branches, 40),
    },
  };
}

// 新規チャットの作業ディレクトリの候補。最近使った順に、今もあるものだけ
export function recentCwds(limit = 40) {
  const latest = new Map();
  for (const { s } of sessions.values()) {
    if (!s?.cwd || (latest.get(s.cwd) ?? '') >= s.end) continue;
    latest.set(s.cwd, s.end);
  }
  return [...latest.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).map(([cwd]) => cwd)
    .filter((cwd) => fs.existsSync(cwd)).slice(0, limit);
}

export function suggestPaths(term, mode, limit = 30) {
  const t = (term ?? '').toLowerCase();
  const counts = new Map();
  const add = (p) => {
    // ファイル単体に加えて親ディレクトリも候補にする
    const parts = p.split('/');
    for (let i = parts.length; i > 2; i--) {
      const sub = parts.slice(0, i).join('/') + (i < parts.length ? '/' : '');
      if (!sub.toLowerCase().includes(t)) continue;
      counts.set(sub, (counts.get(sub) ?? 0) + 1);
    }
  };
  for (const { s } of sessions.values()) {
    if (!s) continue;
    const seen = new Set();
    for (const set of mode === 'read' ? [s.reads] : mode === 'write' ? [s.writes] : [s.reads, s.writes]) {
      for (const p of set) if (!seen.has(p)) { seen.add(p); add(p); }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value, count]) => ({ value, count }));
}

// 表示用のイベント列。ツール呼び出しと結果は1つにまとめる
const RESULT_MAX = 200_000;

export function events(file) {
  const out = [];
  const byToolId = new Map();
  let cwd = null;
  let lastTs = null;
  // 行の uuid → その行の表示が始まる位置。巻き戻したときに、どこから先を外すかに使う
  const startOf = new Map();
  for (const r of readJsonl(file)) {
    // Claude Code で巻き戻すと、会話ログは消さずに印の行を足し、次の発言を巻き戻した先から枝分かれさせる。
    // 外したやり取りは消さずに、印の中に畳んで持つ
    if (r.rewound && r.cutUuid && startOf.has(r.cutUuid)) {
      const dropped = out.splice(startOf.get(r.cutUuid));
      const cut = dropped.find((e) => e.kind === 'user');
      out.push({ ts: lastTs, kind: 'rewind', text: cut?.text ?? '', dropped });
      continue;
    }
    if (r.uuid && !startOf.has(r.uuid)) startOf.set(r.uuid, out.length);
    if (r.timestamp) lastTs = r.timestamp;
    // cd した Bash の結果の行から cwd が変わるので、その呼び出しの後ろに移った先を挟む
    if (r.cwd && cwd && r.cwd !== cwd) out.push({ ts: r.timestamp, kind: 'cwd', text: r.cwd, from: cwd });
    if (r.cwd) cwd = r.cwd;
    const base = { uuid: r.uuid, ts: r.timestamp };
    const c = r.message?.content;
    if (r.type === 'user') {
      const meta = !!(r.isMeta || r.isCompactSummary);
      if (typeof c === 'string') {
        out.push({ ...base, kind: meta ? 'meta' : 'user', text: c, compact: !!r.isCompactSummary });
        continue;
      }
      if (!Array.isArray(c)) continue;
      const texts = [];
      for (const b of c) {
        if (b.type === 'tool_result') {
          const ev = byToolId.get(b.tool_use_id);
          let t = typeof b.content === 'string' ? b.content : textOf(b.content);
          const truncated = t.length > RESULT_MAX;
          if (truncated) t = t.slice(0, RESULT_MAX);
          if (ev) {
            ev.result = t;
            ev.truncated = truncated;
            ev.isError = !!b.is_error;
            const tur = r.toolUseResult;
            if (tur && typeof tur === 'object' && tur.agentId) ev.agentId = tur.agentId;
            ev.resultTs = r.timestamp;
          } else {
            out.push({ ...base, kind: 'tool', name: '(不明)', category: 'tool', input: {}, result: t, isError: !!b.is_error });
          }
        } else if (b.type === 'text') {
          texts.push(b.text);
        } else if (b.type === 'image') {
          texts.push('[画像]');
        }
      }
      if (texts.length) out.push({ ...base, kind: meta ? 'meta' : 'user', text: texts.join('\n') });
    } else if (r.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') {
          out.push({ ...base, kind: 'assistant', text: b.text, model: r.message?.model });
        } else if (b.type === 'thinking') {
          if (b.thinking) out.push({ ...base, kind: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          const ev = { ...base, kind: 'tool', id: b.id, name: b.name, category: toolCategory(b.name), input: b.input ?? {}, result: null };
          if (ev.category === 'mcp') ev.server = mcpServer(b.name);
          byToolId.set(b.id, ev);
          out.push(ev);
        }
      }
    } else if (r.type === 'system') {
      const t = typeof r.content === 'string' ? stripReminders(r.content) : '';
      if (t || r.subtype) out.push({ ...base, kind: 'system', subtype: r.subtype, text: t });
    } else if (r.type === 'pr-link') {
      out.push({ ...base, kind: 'system', subtype: 'pr-link', text: r.prUrl });
    } else if (r.type === 'attachment' && r.attachment?.type === 'queued_command') {
      const p = r.attachment.prompt;
      out.push({ ...base, kind: 'user', text: typeof p === 'string' ? p : textOf(p), queued: true });
    }
  }
  return out;
}

const FILE_MAX = 1024 * 1024;

// セッションで読み書きしたファイルの今の中身。それ以外のファイルは渡さない
export function sessionFile(id, p) {
  const s = getSession(id);
  if (!s || typeof p !== 'string' || !p) return { error: 'not found', code: 404 };
  const abs = path.resolve(s.cwd ?? '/', p);
  if (!s.reads.has(abs) && !s.writes.has(abs)) return { error: 'このセッションで読み書きしたファイルではありません', code: 403 };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: 'ファイルが見つかりません。消されたか、移されたかもしれません', code: 404 };
  }
  if (!st.isFile()) return { error: 'ファイルではありません', code: 400 };
  const fd = fs.openSync(abs, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(st.size, FILE_MAX));
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  const base = { path: abs, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  if (buf.subarray(0, 8000).includes(0)) return { ...base, binary: true, text: null };
  return { ...base, text: buf.toString('utf8'), truncated: st.size > FILE_MAX };
}

// 巻き戻すときに claude に伝える、最後のユーザーの発言。claude の会話と食い違っていると断られる
export function lastPromptUuid(id) {
  const s = getSession(id);
  if (!s) return null;
  let last = null;
  for (const r of readJsonl(s.file)) if (r.uuid && promptText(r)) last = r.uuid;
  return last;
}

export function sessionDetail(id) {
  refresh();
  const s = getSession(id);
  if (!s) return null;
  return {
    session: brief(s, { include: [] }, hideRules()),
    files: { read: [...s.reads].sort(), write: [...s.writes].sort() },
    events: events(s.file),
    agents: s.agents.map((a) => ({ toolUseId: a.toolUseId, agentId: a.agentId })),
  };
}

// 左の一覧と入力欄の上に出すサブエージェントの一覧。始まった順に並べる
export function subagents(id) {
  const s = getSession(id);
  if (!s) return null;
  const dir = path.join(s.file.replace(/\.jsonl$/, ''), 'subagents');
  const now = Date.now();
  return s.agents.map((a) => {
    // 一覧の集計より後に書き足されていることがあるので、ここでも更新時刻を取り直す
    let mtime = a.mtime;
    try {
      mtime = fs.statSync(path.join(dir, `agent-${a.agentId}.jsonl`)).mtimeMs;
    } catch {}
    const stub = { ...a, mtime };
    return { ...stub, running: isRunning(stub, s.agentResults, now), ...agentDetail(path.join(dir, `agent-${a.agentId}.jsonl`), stub) };
  }).sort((x, y) => ((x.start ?? '') < (y.start ?? '') ? -1 : 1));
}

// ビュワーが動かしている claude を止めてよいかを決めるときに使う。始まったばかりのサブエージェントも拾えるように、会話ログを読み直してから見る
export function hasRunningAgents(id) {
  refresh();
  const s = getSession(id);
  if (!s) return false;
  const dir = path.join(s.file.replace(/\.jsonl$/, ''), 'subagents');
  const now = Date.now();
  // 終わった印（meta.json の finished）は会話ログの読み直しでは拾えないことがあるので、ファイルから読み直す
  return s.agents.some((a) => isRunning(agentStub(path.join(dir, `agent-${a.agentId}.jsonl`)), s.agentResults, now));
}

export function agentEvents(sessionId, agentId) {
  const s = getSession(sessionId);
  if (!s || !/^[\w-]+$/.test(agentId)) return null;
  const file = path.join(s.file.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
  if (!fs.existsSync(file)) return null;
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {}
  return { meta, events: events(file) };
}
