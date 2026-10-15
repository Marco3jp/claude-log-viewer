import fs from 'node:fs';
import path from 'node:path';

export function readJsonl(file) {
  const out = [];
  let data;
  try {
    data = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of data.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 書き込み途中の最終行は壊れていることがある
    }
  }
  return out;
}

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[画像]' : ''))
    .filter(Boolean)
    .join('\n');
}

export function toolCategory(name) {
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'bash';
  if (name === 'Agent' || name === 'Task') return 'agent';
  return 'tool';
}

export function mcpServer(name) {
  return name.split('__')[1] ?? name;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

export function fileAccess(name, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  const p = input.file_path ?? input.notebook_path ?? (READ_TOOLS.has(name) ? input.path : undefined);
  if (typeof p !== 'string' || !p) return null;
  const abs = path.isAbsolute(p) ? p : path.join(cwd || '/', p);
  if (WRITE_TOOLS.has(name)) return { mode: 'write', path: abs };
  if (READ_TOOLS.has(name)) return { mode: 'read', path: abs };
  return null;
}

const GH_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/g;
const GH_CMD = /\bgh\s+(issue|pr)\s+(?:view|edit|comment|checks|diff|merge|close|reopen|review|checkout|ready)\s+(\d+)\b[^\n;&|]*/g;
const GH_API = /\brepos\/([\w.-]+\/[\w.-]+)\/(issues|pulls)\/(\d+)/g;

export function findRefs(text, defaultRepo, out) {
  if (!text) return;
  for (const m of text.matchAll(GH_URL)) {
    out.add(`${m[1]}#${m[3]}|${m[2] === 'pull' ? 'pr' : 'issue'}`);
  }
  for (const m of text.matchAll(GH_API)) {
    out.add(`${m[1]}#${m[3]}|${m[2] === 'pulls' ? 'pr' : 'issue'}`);
  }
  for (const m of text.matchAll(GH_CMD)) {
    const repo = m[0].match(/(?:-R|--repo)[=\s]+([\w.-]+\/[\w.-]+)/)?.[1] ?? defaultRepo;
    if (repo && repo.includes('/')) out.add(`${repo}#${m[2]}|${m[1]}`);
  }
}

export function stripReminders(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

export function promptText(r) {
  if (r.type !== 'user' || r.isMeta || r.isCompactSummary || r.isSidechain) return null;
  const c = r.message?.content;
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return null;
  const t = stripReminders(textOf(c));
  if (!t || t.startsWith('<local-command') || t.startsWith('Caveat:')) return null;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([^<]*)<\/command-args>)?/);
  if (cmd) return `${cmd[1]} ${cmd[2] ?? ''}`.trim();
  return t;
}
