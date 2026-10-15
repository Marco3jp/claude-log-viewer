import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = process.env.CLAUDE_LOG_VIEWER_DATA
  || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'claude-log-viewer');
const FILE = path.join(DATA_DIR, 'bookmarks.json');

let marks = null;

function load() {
  if (marks) return marks;
  try {
    marks = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    marks = {};
  }
  return marks;
}

export function isBookmarked(id) {
  return Object.hasOwn(load(), id);
}

export function setBookmark(id, on) {
  const m = load();
  if (on) m[id] = { at: new Date().toISOString() };
  else delete m[id];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 書き込み途中で落ちても壊れたファイルが残らないように、別名で書いてから置き換える
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, FILE);
  return on;
}
