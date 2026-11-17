export type RemoteStatus = 'has_remote' | 'no_remote' | 'remote_gone' | 'merged';

export interface CommitInfo {
  sha: string;
  subject: string;
  author: string;
  time_ms: number;
}

export interface PrInfo {
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  url: string;
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  checks: 'passing' | 'failing' | 'pending' | null;
}

// Result of the background `get_remote_info` pass.
export interface RemoteInfo {
  remoteHeads: Record<string, string[]>;
  prs: Record<string, PrInfo> | null;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  is_clean: boolean;
  remote_status: RemoteStatus;
  created_ms: number | null;
  // Remote of the branch's own upstream, if it has one.
  upstream_remote: string | null;
  // Relative to the upstream, as of the last fetch.
  ahead: number;
  behind: number;
  last_commit: CommitInfo | null;
  // A merge or rebase stopped part-way (e.g. on conflicts).
  operation: 'merge' | 'rebase' | null;
  // Locked with `git worktree lock` (the reason, "" if none), so it can't be removed.
  locked: string | null;
  // The folder was deleted outside git; pruning forgets it.
  missing: boolean;
  // Filled in from RemoteInfo: undefined while loading, null when there's no PR.
  pr?: PrInfo | null;
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

export interface SyncResult {
  path: string;
  branch: string | null;
  outcome: 'pulled' | 'up_to_date' | 'skipped' | 'failed';
  message: string;
}

export interface UpdateOutcome {
  ok: boolean;
  message: string;
  conflicts: string[];
}
