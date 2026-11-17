import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './bookmarks.js';

const DIR = path.join(DATA_DIR, 'memos');
export const MEMO_MAX = 512 * 1024;

const fileOf = (id) => (/^[\w-]+$/.test(id) ? path.join(DIR, `${id}.md`) : null);

export function getMemo(id) {
  const file = fileOf(id);
  if (!file) return null;
  try {
    return { text: fs.readFileSync(file, 'utf8'), updatedAt: fs.statSync(file).mtime.toISOString() };
  } catch {
    return { text: '', updatedAt: null };
  }
}

export function setMemo(id, text) {
  const file = fileOf(id);
  if (!file) return null;
  if (!text.trim()) {
    fs.rmSync(file, { force: true });
    return { text: '', updatedAt: null };
  }
  fs.mkdirSync(DIR, { recursive: true });
  // 書き込み途中で落ちても壊れたファイルが残らないように、別名で書いてから置き換える
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return getMemo(id);
}
