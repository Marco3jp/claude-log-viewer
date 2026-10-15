import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

function remoteOf(configPath) {
  let conf;
  try {
    conf = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null;
  }
  const origin = conf.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/);
  const url = origin?.[1] ?? conf.match(/url\s*=\s*(\S+)/)?.[1];
  const gh = url?.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return gh ? gh[1] : null;
}

function configFor(gitPath) {
  const st = fs.statSync(gitPath);
  if (st.isDirectory()) return path.join(gitPath, 'config');
  // worktree / submodule の .git はファイルで、本体の gitdir を指している
  const gitdir = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim();
  if (!gitdir) return null;
  const abs = path.resolve(path.dirname(gitPath), gitdir);
  try {
    const common = fs.readFileSync(path.join(abs, 'commondir'), 'utf8').trim();
    return path.join(path.resolve(abs, common), 'config');
  } catch {
    return path.join(abs, 'config');
  }
}

// cwd から GitHub の owner/repo を返す。GitHub 以外やリポジトリ外ならルートのディレクトリ名
export function repoOf(cwd) {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);
  let result = null;
  let dir = cwd;
  while (true) {
    const g = path.join(dir, '.git');
    if (fs.existsSync(g)) {
      let remote = null;
      try {
        const conf = configFor(g);
        remote = conf ? remoteOf(conf) : null;
      } catch {}
      result = remote ?? `local:${path.basename(dir)}`;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cache.set(cwd, result);
  return result;
}
