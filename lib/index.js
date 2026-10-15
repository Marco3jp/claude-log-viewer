import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  readJsonl, textOf, toolCategory, mcpServer, fileAccess, findRefs, promptText, stripReminders,
} from './parse.js';
import { repoOf } from './repo.js';
import { isBookmarked } from './bookmarks.js';

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
    title: null, firstPrompt: null, lastPrompt: null,
    cwds: new Set(), branches: new Set(), repos: new Set(), refs: new Set(),
    tools: new Map(), mcp: new Map(),
    reads: new Set(), writes: new Set(),
    start: null, end: null, prompts: 0, turns: 0, bash: 0, subagents: subs.length,
    text: '', lower: '',
  };
  const chunks = [];
  const toolCmd = new Map();

  const handle = (r, isSub) => {
    if (r.type === 'ai-title' && r.aiTitle) s.title = r.aiTitle;
    if (r.type === 'pr-link' && r.prUrl) findRefs(r.prUrl, null, s.refs);
    if (r.timestamp) {
      if (!s.start || r.timestamp < s.start) s.start = r.timestamp;
      if (!s.end || r.timestamp > s.end) s.end = r.timestamp;
    }
    if (r.cwd) {
      s.cwds.add(r.cwd);
      const repo = repoOf(r.cwd);
      if (repo) s.repos.add(repo);
    }
    if (r.gitBranch && r.gitBranch !== 'HEAD') s.branches.add(r.gitBranch);
    const ghRepo = r.cwd ? repoOf(r.cwd) : null;
    const defaultRepo = ghRepo && !ghRepo.startsWith('local:') ? ghRepo : null;
    const c = r.message?.content;
    if (r.type === 'user') {
      const p = isSub ? null : promptText(r);
      if (p) {
        s.prompts++;
        if (!s.firstPrompt) s.firstPrompt = p.slice(0, 300);
        s.lastPrompt = p.slice(0, 300);
        chunks.push(p);
        findRefs(p, defaultRepo, s.refs);
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const t = typeof b.content === 'string' ? b.content : textOf(b.content);
          chunks.push(t.slice(0, RESULT_INDEX_CHARS));
          // 作成した Issue・PR の URL は結果側にしか出ない
          const cmd = toolCmd.get(b.tool_use_id);
          if (cmd && /\bgh\s+(issue|pr)\s+create\b/.test(cmd)) findRefs(t, defaultRepo, s.refs);
        }
      }
    } else if (r.type === 'assistant' && Array.isArray(c)) {
      if (!isSub) s.turns++;
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
  s.text = [s.title ?? '', ...chunks].join('\n\u0000');
  s.lower = s.text.toLowerCase();
  s.cwd = [...s.cwds][0] ?? null;
  return s;
}

export function refresh() {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return;
  }
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
      const s = summarize(file, d.name);
      sessions.set(file, { fp, s });
    }
  }
  for (const k of sessions.keys()) if (!seen.has(k)) sessions.delete(k);
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

function brief(s, q) {
  const refs = [...s.refs].map((x) => {
    const [ref, kind] = x.split('|');
    return { ref, kind };
  });
  return {
    id: s.id,
    bookmarked: isBookmarked(s.id),
    project: s.project,
    title: s.title,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    cwd: s.cwd,
    repos: [...s.repos],
    branches: [...s.branches],
    refs,
    start: s.start,
    end: s.end,
    prompts: s.prompts,
    turns: s.turns,
    bash: s.bash,
    subagents: s.subagents,
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
  // /usage のようなローカルコマンドだけのセッションは返答が残らず、一覧を埋めるので既定では外す
  let hiddenEmpty = 0;
  if (!f.empty) {
    const before = list.length;
    list = list.filter((s) => s.turns > 0);
    hiddenEmpty = before - list.length;
  }
  if (f.sort === 'hits' && q.include.length) {
    list.sort((a, b) => countHits(b.lower, q.include[0]) - countHits(a.lower, q.include[0]));
  } else if (f.sort === 'start') {
    list.sort((a, b) => (a.start < b.start ? 1 : -1));
  } else {
    list.sort((a, b) => (a.end < b.end ? 1 : -1));
  }
  const limit = Math.min(Number(f.limit) || 200, 1000);
  return {
    total: list.length,
    hiddenEmpty,
    indexed: sessions.size,
    projectLabels: projectLabels(),
    sessions: list.slice(0, limit).map((s) => brief(s, q)),
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
  for (const r of readJsonl(file)) {
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

export function sessionDetail(id) {
  refresh();
  const s = getSession(id);
  if (!s) return null;
  return {
    session: brief(s, { include: [] }),
    files: { read: [...s.reads].sort(), write: [...s.writes].sort() },
    events: events(s.file),
  };
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
