export type RemoteStatus = 'has_remote' | 'no_remote' | 'remote_gone' | 'merged';

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  is_clean: boolean;
  remote_status: RemoteStatus;
}

export interface SyncStatus {
  ahead: number;
  behind: number;
  has_upstream: boolean;
}

export type LinkMode = 'symlink' | 'copy';

export interface FileEntry {
  id: string;
  name: string;
  // Absolute (or ~) path to the file to link/copy from.
  source: string;
  // Path inside the worktree it should appear at, e.g. app/.claude/CLAUDE.md.
  target: string;
  // Pre-ticked when grafting a new worktree.
  byDefault: boolean;
}

export interface RepoFiles {
  agents: FileEntry[];
  envs: FileEntry[];
}

// A FileEntry resolved for one run: what to put where, and how.
export interface ApplyEntry {
  name: string;
  source: string;
  target: string;
  mode: LinkMode;
}

export interface FileResult {
  name: string;
  status: 'linked' | 'copied' | 'skipped';
  message: string | null;
}

export interface Editor {
  id: string;
  label: string;
}
