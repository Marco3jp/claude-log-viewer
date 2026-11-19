import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './bookmarks.js';

const FILE = path.join(DATA_DIR, 'settings.json');
export const STATUS_MODES = new Set(['claude', 'command', 'builtin', 'off']);
export const COMMAND_MAX = 4000;
const RULES_MAX = 200;
const RULE_CHARS_MAX = 200;
// title は一覧に出るタイトル（無ければ最初のプロンプト）、text はタイトルと検索の対象の全文に含まれていたら隠す
const DEFAULTS = { statusLine: { mode: 'claude', command: '' }, hideRules: { title: [], text: [] } };

let cache = null;

export function getSettings() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = {
      statusLine: { ...DEFAULTS.statusLine, ...v.statusLine },
      hideRules: { ...DEFAULTS.hideRules, ...v.hideRules },
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function save(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 書き込み途中で落ちても壊れたファイルが残らないように、別名で書いてから置き換える
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FILE);
  cache = next;
  return { settings: next };
}

export function setStatusLine({ mode, command }) {
  if (!STATUS_MODES.has(mode)) return { error: `mode は ${[...STATUS_MODES].join('・')} のどれかです` };
  const cmd = String(command ?? '');
  if (cmd.length > COMMAND_MAX) return { error: 'コマンドが長すぎます' };
  if (mode === 'command' && !cmd.trim()) return { error: 'コマンドを書いてください' };
  return save({ ...getSettings(), statusLine: { mode, command: cmd } });
}

function cleanRules(list) {
  const out = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (out.length > RULES_MAX) return { error: `非表示の条件は ${RULES_MAX} 件までです` };
  if (out.some((x) => x.length > RULE_CHARS_MAX)) return { error: `非表示の条件は 1 件 ${RULE_CHARS_MAX} 字までです` };
  return { rules: out };
}

export function setHideRules({ title, text }) {
  const t = cleanRules(title);
  if (t.error) return t;
  const x = cleanRules(text);
  if (x.error) return x;
  return save({ ...getSettings(), hideRules: { title: t.rules, text: x.rules } });
}
