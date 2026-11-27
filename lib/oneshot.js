import { spawn } from 'node:child_process';
import os from 'node:os';
import { noteRateLimit, noteModelUsage } from './statusline.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// hook と CLAUDE.md を切った claude -p で、道具を持たせずに1回だけ答えさせる。会話ログも残さない
export function askClaude(prompt, { model, schema, system, timeoutMs }) {
  return new Promise((resolve) => {
    const args = [
      '-p', '--safe-mode', '--no-session-persistence', '--tools', '', '--model', model,
      '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt', system,
    ];
    let proc;
    try {
      proc = spawn(CLAUDE_BIN, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: e.message });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      let r;
      try {
        const v = JSON.parse(out);
        r = Array.isArray(v) ? v.findLast((x) => x.type === 'result') : v;
        // ステータスラインの使用率とコンテキストの上限は、この呼び出しの出力からも拾える
        if (Array.isArray(v)) noteRateLimit(v.findLast((x) => x.type === 'rate_limit_event')?.rate_limit_info);
        noteModelUsage(r?.modelUsage);
      } catch {}
      if (r?.structured_output) resolve({ result: r.structured_output });
      else resolve({ error: r?.result || err.trim() || `claude が ${signal ?? `終了コード ${code}`} で終わりました` });
    });
    proc.stdin.end(prompt);
  });
}
