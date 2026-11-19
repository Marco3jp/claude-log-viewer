import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './bookmarks.js';

const FILE = path.join(DATA_DIR, 'hidden.json');

let ids = null;

function load() {
  if (ids) return ids;
  try {
    ids = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    ids = {};
  }
  return ids;
}

export function isHidden(id) {
  return Object.hasOwn(load(), id);
}

export function setHidden(id, on) {
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
