#!/usr/bin/env node
// ~/.claude/settings.json の hooks.PermissionRequest に、ターミナルの許可の確認をビュワーへ送る hook を足す・外す。
// 書き換えるかどうかをコマンド行から読めるように、--dry-run か --run のどちらかを必ず付ける
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hookCommand, isViewerHook, DEFAULT_PORT } from '../lib/hook-command.js';

const USAGE = `使い方: npm run setup-hook -- (--dry-run | --run) [--remove]

  --dry-run   書き換えずに、hooks.PermissionRequest の変更前と変更後を出す
  --run       書き換える。元のファイルは settings.json.bak に残す
  --remove    足す代わりに、このビュワーの hook を外す

ビュワーを PORT や CLAUDE_LOG_VIEWER_DATA を変えて起動しているときは、同じ値を付けて実行してください。`;

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !['--dry-run', '--run', '--remove'].includes(a));
if (unknown.length || args.has('--dry-run') === args.has('--run')) {
  console.error(USAGE);
  process.exit(2);
}
const run = args.has('--run');
const remove = args.has('--remove');

const FILE = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const command = hookCommand({ port: Number(process.env.PORT) || DEFAULT_PORT });

let text = null;
try {
  text = fs.readFileSync(FILE, 'utf8');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
let settings;
try {
  settings = text == null ? {} : JSON.parse(text);
} catch (e) {
  console.error(`${FILE} を JSON として読めませんでした。手で直してから実行してください: ${e.message}`);
  process.exit(1);
}

const before = structuredClone(settings.hooks?.PermissionRequest ?? []);
// このビュワーの hook だけを外す。同じ組にほかの hook があれば、その組は残す
const kept = before
  .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isViewerHook(h.command)) }))
  .filter((group) => group.hooks.length);
const after = remove ? kept : [...kept, { hooks: [{ type: 'command', command }] }];

const show = (label, list) => console.log(`${label}\n${JSON.stringify(list, null, 2)}\n`);
show(`${FILE} の hooks.PermissionRequest（変更前）`, before);
show('変更後', after);

if (JSON.stringify(before) === JSON.stringify(after)) {
  console.log(remove ? 'このビュワーの hook は登録されていません。何も変えません' : 'もう同じ hook が登録されています。何も変えません');
  process.exit(0);
}
if (!run) {
  console.log('--dry-run なので書き換えていません。書き換えるときは --run を付けて実行してください');
  process.exit(0);
}

const next = { ...settings, hooks: { ...settings.hooks, PermissionRequest: after } };
if (!after.length) delete next.hooks.PermissionRequest;
fs.mkdirSync(path.dirname(FILE), { recursive: true });
if (text != null) fs.writeFileSync(`${FILE}.bak`, text);
// 書き込み途中で落ちても壊れたファイルが残らないように、別名で書いてから置き換える
const tmp = `${FILE}.${process.pid}.tmp`;
fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
fs.renameSync(tmp, FILE);
console.log(`書き換えました。${text != null ? `元のファイルは ${FILE}.bak にあります。` : ''}`);
if (!remove) console.log('ビュワーの設定画面の「承認」で「hook から届いた確認を受け付ける」をオンにすると使えるようになります');
