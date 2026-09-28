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
