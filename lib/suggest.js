import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LIMIT = 50;
const FILES_TTL_MS = 30 * 1000;
const FILES_MAX = 20000;
const WALK_SKIP = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.cache', '__pycache__', '.venv']);
const DESCRIPTION_MAX = 200;

// ビュワーが起動した claude に initialize を送って受け取った、そのディレクトリで使えるコマンドの一覧
const commandsByCwd = new Map();

export function noteCommands(cwd, commands) {
  if (!cwd || !Array.isArray(commands)) return;
  commandsByCwd.set(cwd, commands.filter((c) => c && typeof c.name === 'string' && !c.name.startsWith('__')).map((c) => ({
    name: c.name,
    description: String(c.description ?? '').slice(0, DESCRIPTION_MAX),
    argumentHint: c.argumentHint ?? null,
  })));
}

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// commands/ の下の .md。サブディレクトリは名前を : でつなぐ
function scanCommands(dir, prefix = '') {
  const out = [];
  for (const d of listDir(dir)) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...scanCommands(p, `${prefix}${d.name}:`));
    else if (d.name.endsWith('.md')) {
      const fm = frontmatter(readText(p) ?? '');
      out.push({ name: `${prefix}${d.name.slice(0, -3)}`, description: (fm.description ?? '').slice(0, DESCRIPTION_MAX), argumentHint: fm['argument-hint'] ?? null });
    }
  }
  return out;
}

function scanSkills(dir) {
  const out = [];
  for (const d of listDir(dir)) {
    if (!d.isDirectory()) continue;
    const text = readText(path.join(dir, d.name, 'SKILL.md'));
    if (text == null) continue;
    const fm = frontmatter(text);
    if (fm['user-invocable'] === 'false') continue;
    out.push({ name: fm.name || d.name, description: (fm.description ?? '').slice(0, DESCRIPTION_MAX), argumentHint: fm['argument-hint'] ?? null });
  }
  return out;
}

// まだ claude を起動していないディレクトリでは、ユーザーとプロジェクトのコマンド・スキルのファイルから拾う。
// 組み込みのコマンドとプラグインのものは入らない
function scanned(cwd) {
  const home = path.join(os.homedir(), '.claude');
  const project = cwd ? path.join(cwd, '.claude') : null;
  return [
    ...(project ? [...scanCommands(path.join(project, 'commands')), ...scanSkills(path.join(project, 'skills'))] : []),
    ...scanCommands(path.join(home, 'commands')),
    ...scanSkills(path.join(home, 'skills')),
  ];
}

function rank(items, q, key) {
  const t = q.toLowerCase();
  const scored = [];
  for (const x of items) {
    const v = key(x).toLowerCase();
    const base = v.split('/').filter(Boolean).pop() ?? v;
    const score = v.startsWith(t) ? 0 : base.startsWith(t) ? 1 : v.includes(t) ? 2 : -1;
    if (score >= 0) scored.push([score, x]);
  }
  return scored.sort((a, b) => a[0] - b[0] || key(a[1]).length - key(b[1]).length).map(([, x]) => x);
}

export function suggestCommands(cwd, q) {
  const known = commandsByCwd.get(cwd);
  const list = known ?? scanned(cwd);
  const seen = new Set();
  const unique = list.filter((c) => !seen.has(c.name) && seen.add(c.name));
  return { source: known ? 'claude' : 'files', items: rank(unique, q, (c) => c.name).slice(0, LIMIT) };
}

const filesCache = new Map();

function gitFiles(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      resolve(err ? null : out.split('\n').filter(Boolean).slice(0, FILES_MAX));
    });
  });
}

// git の外では、よくある生成物のディレクトリを飛ばして歩く。数に限りがあるので、浅いところから順に拾う
function walk(cwd) {
  const out = [];
  const queue = [''];
  for (let i = 0; i < queue.length && out.length < FILES_MAX; i++) {
    const rel = queue[i];
    for (const d of listDir(path.join(cwd, rel))) {
      if (WALK_SKIP.has(d.name)) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) queue.push(p);
      else out.push(p);
    }
  }
  return out;
}

async function filesOf(cwd) {
  const hit = filesCache.get(cwd);
  if (hit && Date.now() - hit.at < FILES_TTL_MS) return hit.paths;
  const files = (await gitFiles(cwd)) ?? walk(cwd);
  const dirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const paths = [...dirs, ...files];
  filesCache.set(cwd, { at: Date.now(), paths });
  return paths;
}

export async function suggestFiles(cwd, q) {
  if (!cwd || !fs.existsSync(cwd)) return { items: [] };
  const paths = await filesOf(cwd);
  return { items: rank(paths, q, (p) => p).slice(0, LIMIT).map((p) => ({ name: p })) };
}
