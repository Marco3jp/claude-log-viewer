import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4317;
export const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'permission-request.mjs');

// ~/.claude/settings.json に登録する hook のコマンド。既定と違うポートとデータ用ディレクトリは hook にも渡す
export function hookCommand({ port = Number(process.env.PORT) || DEFAULT_PORT, dataDir = process.env.CLAUDE_LOG_VIEWER_DATA } = {}) {
  return [
    port !== DEFAULT_PORT ? `CLAUDE_LOG_VIEWER_PORT=${port}` : null,
    dataDir ? `CLAUDE_LOG_VIEWER_DATA=${JSON.stringify(dataDir)}` : null,
    `node ${JSON.stringify(HOOK_SCRIPT)}`,
  ].filter(Boolean).join(' ');
}

// 登録済みの hook のうち、このビュワーのもの。clone し直してパスが変わったものも含める
export function isViewerHook(command) {
  return typeof command === 'string' && /hooks\/permission-request\.mjs/.test(command);
}
