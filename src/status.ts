import { RemoteInfo, WorktreeInfo } from './types';

// Refines the local-only statuses from `get_worktrees` with what the remote
// actually has: whether each branch still exists there, and its latest PR.
export const applyRemoteInfo = (worktrees: WorktreeInfo[], info: RemoteInfo | null): WorktreeInfo[] => {
  if (!info) return worktrees;
  return worktrees.map((wt) => {
    const pr = wt.branch && info.prs ? info.prs[wt.branch] ?? null : info.prs ? null : undefined;
    let status = wt.remote_status;
    const heads = wt.upstream_remote ? info.remoteHeads[wt.upstream_remote] : undefined;
    // Only when that remote answered; offline keeps the local guess.
    if (wt.branch && heads) status = heads.includes(wt.branch) ? 'has_remote' : 'remote_gone';
    // Merged, but the remote branch was never deleted.
    if (status === 'has_remote' && pr?.state === 'MERGED') status = 'merged';
    return { ...wt, remote_status: status, pr };
  });
};
