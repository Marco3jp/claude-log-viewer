#!/usr/bin/env node
// Claude Code の PermissionRequest hook。確認の中身をビュワーに渡し、ビュワーが決めたら allow / deny を返す。
// ビュワーが動いていない・人が答えなかったときは何も出さずに終わり、いつものダイアログに任せる
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const DATA_DIR = process.env.CLAUDE_LOG_VIEWER_DATA
  || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'claude-log-viewer');
const PORT = Number(process.env.CLAUDE_LOG_VIEWER_PORT) || 4317;
// サーバーは 540 秒で見切るので、それより少し長く待つ。hook の timeout（既定 600 秒）よりは短くする。
// fetch は応答のヘッダーを 300 秒で諦めるので、待つ時間を決められる http.request を使う
const WAIT_MS = 570 * 1000;

function post(body, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/api/hook/permission-request',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': body.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(WAIT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let token;
  try {
    token = fs.readFileSync(path.join(DATA_DIR, 'hook-token'), 'utf8').trim();
  } catch {
    return;
  }
  const res = await post(Buffer.concat(chunks), token);
  if (res.status !== 200) return;
  const { decision } = JSON.parse(res.text);
  if (decision?.behavior !== 'allow' && decision?.behavior !== 'deny') return;
  const out = decision.behavior === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: String(decision.message ?? '') };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: out } }));
}

main().catch(() => {}).finally(() => process.exit(0));
