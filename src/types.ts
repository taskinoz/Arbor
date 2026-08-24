export interface WorktreeInfo {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  is_clean: boolean;
}

export interface SyncStatus {
  ahead: number;
  behind: number;
  has_upstream: boolean;
}
