import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
// 普段と違うソケットの tmux サーバーを使っているときは、その名前（tmux -L に渡すもの）を指定する
const SOCKET_ARGS = process.env.TMUX_SOCKET_NAME ? ['-L', process.env.TMUX_SOCKET_NAME] : [];
const TIMEOUT_MS = 3000;
const SCREEN_TAIL = 14;
// 括弧付きの貼り付けのあと、すぐ Enter を送ると貼り付けの途中に混ざることがあるので少し待つ
const ENTER_DELAY_MS = 300;
const RULE = /^─{10,}/;

function tmux(args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile(TMUX_BIN, [...SOCKET_ARGS, ...args], { timeout: TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (input != null) p.stdin.end(input);
  });
}

function ps(pid) {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: TIMEOUT_MS }, (err, out) => resolve(err ? null : Number(out.trim()) || null));
  });
}

// セッションの記録の tmux は「セッション名:@ウィンドウ.%ペイン」の形で、どの tmux サーバーかは書かれていないので、
// 普段の（か TMUX_SOCKET_NAME の）tmux サーバーでペインを引き、そのペインのプロセスが claude の親（か claude そのもの）かを確かめる
export async function findPane(info) {
  const pane = info?.tmux?.match(/%\d+$/)?.[0];
  if (!pane) return { error: 'tmux の外で開かれているセッションです' };
  let panePid;
  try {
    panePid = Number((await tmux(['display-message', '-p', '-t', pane, '#{pane_pid}'])).trim());
  } catch {
    return { error: `tmux のペイン ${pane} が見つかりません` };
  }
  let pid = info.pid;
  for (let i = 0; i < 6 && pid; i++) {
    if (pid === panePid) return { pane };
    pid = await ps(pid);
  }
  return { error: `tmux のペイン ${pane} で動いているのは、このセッションの claude ではありません` };
}

// 画面の下のほうにある、横線 2 本にはさまれた ❯ の行が入力欄。選択肢の ❯ は行頭に空白が入るので区別できる
export function inputState(screen) {
  const lines = screen.replace(/\s+$/, '').split('\n');
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0);
  for (let k = rules.length - 1; k > 0; k--) {
    const body = lines.slice(rules[k - 1] + 1, rules[k]);
    if (!body.length || !body[0].startsWith('❯')) continue;
    const text = [body[0].slice(1), ...body.slice(1)].join('\n').trim();
    return text ? { state: 'draft', text } : { state: 'empty' };
  }
  return { state: 'none' };
}

function tail(screen) {
  return screen.replace(/\s+$/, '').split('\n').filter((l) => l.trim()).slice(-SCREEN_TAIL).join('\n');
}

export async function sendViaTmux(info, text) {
  const found = await findPane(info);
  if (found.error) return { error: found.error, code: 409 };
  const screen = await tmux(['capture-pane', '-p', '-t', found.pane]);
  const input = inputState(screen);
  if (input.state === 'draft') {
    return { error: 'ターミナルの入力欄に書きかけの文があります。消すか送ってから、もう一度送ってください', screen: tail(screen), code: 409 };
  }
  if (input.state === 'none') {
    return { error: 'ターミナルに選択肢などが出ていて、入力欄が見つかりません。ターミナルで答えてから、もう一度送ってください', screen: tail(screen), code: 409 };
  }
  const buffer = `viewer-${randomUUID()}`;
  await tmux(['load-buffer', '-b', buffer, '-'], text);
  await tmux(['paste-buffer', '-p', '-d', '-b', buffer, '-t', found.pane]);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  await tmux(['send-keys', '-t', found.pane, 'Enter']);
  return { pane: found.pane };
}
