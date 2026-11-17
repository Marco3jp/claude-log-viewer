import fs from 'node:fs';
import path from 'node:path';
import { readJsonl } from './parse.js';

// finished が付かないまま claude が落ちることがあるので、これより長く書かれていないものは終わったことにする
export const RUNNING_STALE_MS = 10 * 60 * 1000;
const INPUT_TEXT_MAX = 200;
// 親に結果を返すための内部のツール。作業の中身ではないので数えない
const INTERNAL_TOOLS = new Set(['SubagentHandback']);

function readMeta(logFile) {
  try {
    return JSON.parse(fs.readFileSync(logFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

// 一覧と集計に使う軽い情報。中身は読まず、meta.json と更新時刻だけを見る
export function agentStub(logFile) {
  const meta = readMeta(logFile);
  let mtime = 0;
  try {
    mtime = fs.statSync(logFile).mtimeMs;
  } catch {}
  return {
    agentId: path.basename(logFile, '.jsonl').replace(/^agent-/, ''),
    toolUseId: meta.toolUseId ?? null,
    description: meta.description ?? null,
    agentType: meta.agentType ?? null,
    background: meta.requestShape === 'background',
    finished: !!meta.finished,
    mtime,
  };
}

export function isRunning(stub, resultIds, now = Date.now()) {
  if (stub.finished) return false;
  if (stub.toolUseId && resultIds.has(stub.toolUseId)) return false;
  return now - stub.mtime < RUNNING_STALE_MS;
}

function shortInput(input) {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (typeof v === 'string') out[k] = v.length > INPUT_TEXT_MAX ? `${v.slice(0, INPUT_TEXT_MAX)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const detailCache = new Map();

// 使ったツールの数・最後に使ったツール・始まりと最後の時刻。ログが変わったときだけ読み直す
export function agentDetail(logFile, stub) {
  const key = `${logFile}:${stub.mtime}`;
  const hit = detailCache.get(logFile);
  if (hit?.key === key) return hit.value;
  let start = null;
  let last = null;
  let tools = 0;
  let lastTool = null;
  for (const r of readJsonl(logFile)) {
    if (r.timestamp) {
      start ??= r.timestamp;
      last = r.timestamp;
    }
    const c = r.message?.content;
    if (r.type !== 'assistant' || !Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type !== 'tool_use' || INTERNAL_TOOLS.has(b.name)) continue;
      tools++;
      lastTool = { name: b.name, input: shortInput(b.input) };
    }
  }
  const value = { start, last, tools, lastTool };
  detailCache.set(logFile, { key, value });
  return value;
}
