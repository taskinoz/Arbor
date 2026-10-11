// Shortens an absolute path under the user's home directory to a `~`-relative
// one for display. Never use this for values passed back to git/Tauri
// commands - those need the real absolute path.
export function toDisplayPath(path: string, home: string | null): string {
  if (!home) return path;
  if (path === home) return '~';
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

export const DEFAULT_WORKTREE_DIR = '.worktree';

// Where new worktrees are created. Relative dirs live inside the repo root
// (".worktree" -> <repo>/.worktree); absolute and ~ dirs are used as-is.
export function resolveWorktreeBase(repoPath: string, dir: string, home: string | null): string {
  const d = (dir.trim() || DEFAULT_WORKTREE_DIR).replace(/\/+$/, '');
  if (d === '~' || d.startsWith('~/')) return home ? `${home}${d.slice(1)}` : d;
  if (d.startsWith('/')) return d;
  return `${repoPath}/${d.replace(/^\.\//, '')}`;
}

export const lastSegment = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? '';
