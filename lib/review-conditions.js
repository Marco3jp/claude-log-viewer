// 自動で許可せずに人に回す条件。設定画面で条件ごとに切り替えられる。
// command はコマンドの文字列だけで決め、model はモデルの判定で決める。host は ~/.claude/settings.json の内容で決める
export const COMMAND_RULES = [
  { id: 'git-push', label: 'git push', reason: 'git push でリモートに書き込みます', re: /\bgit\b[^\n|;&]*\bpush\b/ },
  { id: 'delete', label: 'ファイルの削除（rm など）', reason: 'ファイルを消します', re: /(^|[\s;&|(`])(rm|rmdir|shred|unlink)\s/ },
  { id: 'gh-api-write', label: 'GET 以外の gh api', reason: 'gh api で GET 以外を送ります', re: /\bgh\s+api\b[^\n|;&]*(\s-X\s*(?!GET\b)\w+|--method[\s=]+(?!GET\b)\w+|\s-[fF]\s|--(raw-)?field\b|--input\b)/i },
  { id: 'gh-pr-issue-write', label: 'gh での PR・Issue の書き換え（create・merge・comment など）', reason: 'GitHub の PR・Issue を書き換えます', re: /\bgh\s+(pr|issue)\s+(create|merge|close|reopen|comment|edit|review|ready|delete|lock|unlock|transfer|develop)\b/ },
  { id: 'gh-repo-write', label: 'gh でのリポジトリ・リリース・ワークフローなどへの書き込み', reason: 'GitHub に書き込みます', re: /\bgh\s+(release|repo|workflow|run|secret|variable|label|gist|ruleset)\s+(create|delete|edit|run|rerun|cancel|set|upload|fork|rename|archive|enable|disable)\b/ },
  { id: 'http-write', label: 'GET 以外の HTTP（curl・wget など）', reason: 'HTTP で GET 以外を送ります', re: /\b(curl|wget|http|xh)\b[^\n|;&]*(\s-X\s*(?!GET\b)\w+|--request[\s=]+(?!GET\b)\w+|\s-d\b|--data|\s-F\b|--form|\s-T\b|--upload-file|--post)/i },
  { id: 'db', label: 'データベースにつなぐ（mysql・psql など）', reason: 'データベースにつなぎます', re: /\b(mysql|psql|mongo|mongosh|redis-cli|sqlite3)\b/ },
  { id: 'bq', label: 'BigQuery（bq）', reason: 'BigQuery を動かします（課金があります）', re: /\bbq\b/ },
  { id: 'sql-write', label: 'SQL の書き込みらしき語（INSERT・UPDATE・DELETE など）', reason: 'SQL の書き込みらしき語が入っています', re: /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/ },
  { id: 'system', label: 'システムやプロセスの操作（sudo・kill・launchctl など）', reason: 'システムやプロセスを操作します', re: /\b(sudo|launchctl|systemctl|kill|pkill|killall|shutdown|reboot|crontab)\b/ },
  { id: 'terraform', label: 'terraform で状態を変える（apply・destroy など）', reason: 'terraform で状態を変えます', re: /\bterraform\s+(apply|destroy|import|state|taint|untaint)\b/ },
  { id: 'aws', label: 'AWS への書き込み', reason: 'AWS に書き込みます', re: /\baws\s+\S+\s+\S*(delete|put|create|update|remove|terminate|stop|start|modify|attach|detach|rm|cp|mv|sync|invoke|publish|send)\S*/ },
  { id: 'kubectl', label: 'Kubernetes の書き換え', reason: 'Kubernetes を書き換えます', re: /\bkubectl\s+(apply|delete|edit|patch|exec|scale|rollout|drain|cordon|replace|create)\b/ },
  { id: 'publish', label: 'パッケージやイメージの公開（npm publish・docker push）', reason: 'パッケージやイメージを公開します', re: /\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b/ },
  { id: 'remote-shell', label: '別のマシンへの接続（ssh・scp・rsync）', reason: '別のマシンにつなぎます', re: /\b(ssh|scp|rsync|sftp)\b/ },
  { id: 'chmod', label: 'ファイルの権限の変更（chmod・chown）', reason: 'ファイルの権限を変えます', re: /\b(chmod|chown)\b/ },
  { id: 'prod', label: '本番らしき名前（prod・production）', reason: '本番らしき名前が入っています', re: /(^|[\s/._-])(prod|production)([\s/._:-]|$)/i },
];

export const HOST_CONDITION = {
  id: 'denied-hosts',
  label: 'sandbox で止めているホストにつなぐ（~/.claude/settings.json の sandbox.network.deniedDomains）',
};

export const MODEL_CONDITIONS = [
  { id: 'remote-write', label: '手元の外に書き込む・送信する', reason: '手元の外に書き込みます', on: true },
  { id: 'local-write', label: '手元のファイル・コンテナ・ローカルの git を書き換える', reason: '手元のファイルなどを書き換えます', on: false },
  { id: 'irreversible', label: '元に戻せない操作が含まれる', reason: '元に戻せない操作が含まれます', on: true },
  { id: 'heavy', label: '重い（長くかかる・通信や課金が多い・マシンの負荷が大きい）', reason: '重い処理です', on: true },
  { id: 'unreadable', label: 'コマンドに出てくるスクリプトの中身を読めない', reason: '中身を読めないファイルがあります', on: true },
];

// 設定画面に出す一覧。on は条件の既定値
export const CONDITIONS = [
  ...COMMAND_RULES.map(({ id, label }) => ({ id, label, group: 'command', on: true })),
  { ...HOST_CONDITION, group: 'host', on: true },
  ...MODEL_CONDITIONS.map(({ id, label, on }) => ({ id, label, group: 'model', on })),
];

const DEFAULT_ON = new Map(CONDITIONS.map((c) => [c.id, c.on]));

export function isConditionId(id) {
  return DEFAULT_ON.has(id);
}

export function conditionOn(review, id) {
  return review?.conditions?.[id] ?? DEFAULT_ON.get(id) ?? true;
}
