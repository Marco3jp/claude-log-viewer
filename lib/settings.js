import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './bookmarks.js';

const FILE = path.join(DATA_DIR, 'settings.json');
export const STATUS_MODES = new Set(['claude', 'command', 'builtin', 'off']);
export const COMMAND_MAX = 4000;
const DEFAULTS = { statusLine: { mode: 'claude', command: '' } };

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = { statusLine: { ...DEFAULTS.statusLine, ...v.statusLine } };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export function setStatusLine({ mode, command }) {
  if (!STATUS_MODES.has(mode)) return { error: `mode は ${[...STATUS_MODES].join('・')} のどれかです` };
  const cmd = String(command ?? '');
  if (cmd.length > COMMAND_MAX) return { error: 'コマンドが長すぎます' };
  if (mode === 'command' && !cmd.trim()) return { error: 'コマンドを書いてください' };
  const next = { ...getSettings(), statusLine: { mode, command: cmd } };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 書き込み途中で落ちても壊れたファイルが残らないように、別名で書いてから置き換える
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  cache = next;
  return { settings: next };
}
