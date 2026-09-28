import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { WorktreeInfo, SyncStatus } from '../types';
import { toDisplayPath } from '../utils/path';
import {
  X,
  Code,
  Trash2,
  AlertTriangle,
  Copy,
  Check,
  Download,
  ArrowDown,
  ArrowUp,
  Loader2,
  GitPullRequest,
} from 'lucide-react';

type SyncAction = 'fetch' | 'pull' | 'push' | null;

interface DetailsPanelProps {
  worktree: WorktreeInfo;
  repoPath: string;
  side: 'left' | 'right';
  homeDir: string | null;
  onClose: () => void;
  onOpenInCode: (path: string) => Promise<void>;
  onDeleteWorktree: (path: string, force: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export const DetailsPanel: React.FC<DetailsPanelProps> = ({
  worktree,
  repoPath,
  side,
  homeDir,
  onClose,
  onOpenInCode,
  onDeleteWorktree,
  onRefresh,
}) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [branchCopied, setBranchCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull request lookup (via `gh`), scoped to this worktree's branch - finds
  // a PR even if it's since been closed/merged and its branch deleted.
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prLoading, setPrLoading] = useState(false);

  // Remote sync state (fetch / pull / push), scoped to this specific worktree
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncStatusLoading, setSyncStatusLoading] = useState(false);
  const [runningAction, setRunningAction] = useState<SyncAction>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  const loadSyncStatus = async (path: string) => {
    setSyncStatusLoading(true);
    try {
      const status: SyncStatus = await invoke('get_sync_status', { path });
      setSyncStatus(status);
    } catch (err) {
      console.error('Failed to load sync status:', err);
      setSyncStatus(null);
    } finally {
      setSyncStatusLoading(false);
    }
  };

  useEffect(() => {
    setSyncError(null);
    setSyncMessage(null);
    loadSyncStatus(worktree.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktree.path]);

  useEffect(() => {
    const branch = worktree.branch;
    if (!branch) {
      setPrUrl(null);
      return;
    }
    let cancelled = false;
    setPrLoading(true);
    setPrUrl(null);
    invoke<string | null>('get_pr_url', { repoPath, branch })
      .then((url) => {
        if (!cancelled) setPrUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPrUrl(null);
      })
      .finally(() => {
        if (!cancelled) setPrLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, worktree.branch]);

  const runSyncAction = async (action: Exclude<SyncAction, null>) => {
    if (runningAction) return; // A sync command is already running against this worktree
    setRunningAction(action);
    setSyncError(null);
    setSyncMessage(null);
    try {
      const command = action === 'fetch' ? 'git_fetch' : action === 'pull' ? 'git_pull' : 'git_push';
      const result: string = await invoke(command, { path: worktree.path });
      setSyncMessage(result || `${action} completed`);
      await loadSyncStatus(worktree.path);
      // Pull can change files/HEAD, so refresh the worktree list/status too
      await onRefresh();
    } catch (err: any) {
      setSyncError(err?.toString() || `Failed to ${action}`);
    } finally {
      setRunningAction(null);
    }
  };

  const handleCopyPath = () => {
    navigator.clipboard.writeText(worktree.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyBranch = () => {
    if (!worktree.branch) return;
    navigator.clipboard.writeText(worktree.branch);
    setBranchCopied(true);
    setTimeout(() => setBranchCopied(false), 2000);
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await onDeleteWorktree(worktree.path, forceDelete);
      // The parent already reassigns the selection to the next sensible
      // worktree (e.g. root) once its list refreshes, so the panel simply
      // updates in place rather than closing and needing to be reopened.
      setShowConfirm(false);
      setForceDelete(false);
    } catch (err: any) {
      setError(err?.toString() || 'Failed to delete worktree');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`details-panel panel-${side}`}>
      {deleting && (
        <div className="panel-deleting-overlay">
          <Loader2 size={28} className="loading-spinner" />
          <span>Removing worktree...</span>
          <span className="panel-deleting-hint">This can take a moment for large directories</span>
        </div>
      )}

      <div className="panel-header">
        <span className="panel-title">Worktree Details</span>
        <button type="button" className="panel-close" onClick={onClose} disabled={deleting}>
          <X size={16} />
        </button>
      </div>

      <div className="details-panel-scroll">
      <div className="detail-row">
        <span className="detail-label">Branch</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="detail-value mono" style={{ flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {worktree.branch || 'Detached HEAD'}
          </span>
          {worktree.branch && (
            <button
              type="button"
              className="panel-close"
              style={{ padding: '6px' }}
              title="Copy branch name"
              onClick={handleCopyBranch}
            >
              {branchCopied ? <Check size={14} style={{ color: 'var(--accent-green)' }} /> : <Copy size={14} />}
            </button>
          )}
          {prLoading && (
            <Loader2 size={13} className="loading-spinner" style={{ color: 'var(--text-muted)' }} />
          )}
          {!prLoading && prUrl && (
            <button
              type="button"
              className="panel-close"
              style={{ padding: '6px' }}
              title="View pull request"
              onClick={() => openUrl(prUrl)}
            >
              <GitPullRequest size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="detail-row">
        <span className="detail-label">Remote Sync</span>
        <div className="sync-status-line">
          {syncStatusLoading ? (
            <span className="sync-status-text muted">Checking remote...</span>
          ) : !syncStatus || !syncStatus.has_upstream ? (
            <span className="sync-status-text muted">No upstream branch</span>
          ) : syncStatus.ahead === 0 && syncStatus.behind === 0 ? (
            <span className="sync-status-text up-to-date">
              <Check size={13} /> Up to date
            </span>
          ) : (
            <>
              {syncStatus.behind > 0 && (
                <span className="sync-pill behind">
                  <ArrowDown size={12} /> {syncStatus.behind} to pull
                </span>
              )}
              {syncStatus.ahead > 0 && (
                <span className="sync-pill ahead">
                  <ArrowUp size={12} /> {syncStatus.ahead} to push
                </span>
              )}
            </>
          )}
        </div>

        <div className="sync-buttons">
          <button
            type="button"
            className="btn-sync"
            onClick={() => runSyncAction('fetch')}
            disabled={runningAction !== null}
            title="git fetch"
          >
            {runningAction === 'fetch' ? (
              <Loader2 size={14} className="loading-spinner" />
            ) : (
              <Download size={14} />
            )}
            <span>Fetch</span>
          </button>
          <button
            type="button"
            className="btn-sync"
            onClick={() => runSyncAction('pull')}
            disabled={runningAction !== null}
            title="git pull"
          >
            {runningAction === 'pull' ? (
              <Loader2 size={14} className="loading-spinner" />
            ) : (
              <ArrowDown size={14} />
            )}
            <span>Pull</span>
          </button>
          <button
            type="button"
            className="btn-sync"
            onClick={() => runSyncAction('push')}
            disabled={runningAction !== null}
            title="git push"
          >
            {runningAction === 'push' ? (
              <Loader2 size={14} className="loading-spinner" />
            ) : (
              <ArrowUp size={14} />
            )}
            <span>Push</span>
          </button>
        </div>

        {syncError && (
          <div className="sync-feedback error">{syncError}</div>
        )}
        {!syncError && syncMessage && (
          <div className="sync-feedback success">{syncMessage}</div>
        )}
      </div>

      <div className="detail-row">
        <span className="detail-label">Status</span>
        <div className={`status-badge ${worktree.is_clean ? 'clean' : 'dirty'}`}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: worktree.is_clean ? 'var(--accent-green)' : 'var(--accent-amber)',
              display: 'inline-block',
            }}
          />
          {worktree.is_clean ? 'Clean' : 'Modified (Dirty)'}
        </div>
      </div>

      {worktree.branch && (
        <div className="detail-row">
          <span className="detail-label">Remote</span>
          <div className={`status-badge ${worktree.remote_status.replace('_', '-')}`}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                backgroundColor:
                  worktree.remote_status === 'remote_gone'
                    ? 'var(--accent-red)'
                    : worktree.remote_status === 'merged'
                    ? 'var(--accent-purple)'
                    : worktree.remote_status === 'no_remote'
                    ? 'var(--accent-grey)'
                    : 'var(--accent-green)',
                display: 'inline-block',
              }}
            />
            {worktree.remote_status === 'remote_gone'
              ? 'Remote Branch Deleted'
              : worktree.remote_status === 'merged'
              ? 'Merged, Remote Not Deleted'
              : worktree.remote_status === 'no_remote'
              ? 'No Remote Branch'
              : 'Tracking Remote'}
          </div>
        </div>
      )}

      <div className="detail-row">
        <span className="detail-label">Directory Path</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span className="detail-value mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={worktree.path}>
            {toDisplayPath(worktree.path, homeDir)}
          </span>
          <button
            type="button"
            className="panel-close"
            style={{ padding: '6px' }}
            title="Copy path"
            onClick={handleCopyPath}
          >
            {copied ? <Check size={14} style={{ color: 'var(--accent-green)' }} /> : <Copy size={14} />}
          </button>
        </div>
      </div>

      <div className="detail-row">
        <span className="detail-label">HEAD Commit</span>
        <span className="detail-value mono" style={{ fontSize: '0.8rem' }}>
          {worktree.head}
        </span>
      </div>

      <div className="panel-actions">
        <button
          type="button"
          className="btn-action primary"
          onClick={() => onOpenInCode(worktree.path)}
        >
          <Code size={16} />
          <span>Open in VS Code</span>
        </button>

        {!worktree.is_main && (
          !showConfirm ? (
            <button
              type="button"
              className="btn-action danger"
              onClick={() => setShowConfirm(true)}
            >
              <Trash2 size={16} />
              <span>Delete Worktree</span>
            </button>
          ) : (
            <div
              style={{
                padding: '12px',
                background: 'rgba(255, 82, 82, 0.05)',
                border: '1px solid rgba(255, 82, 82, 0.2)',
                borderRadius: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--accent-red)', fontSize: '0.85rem', fontWeight: 600 }}>
                <AlertTriangle size={16} />
                <span>Are you absolutely sure?</span>
              </div>
              
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                This will remove the worktree folder and clean git references. Local uncommitted changes will be lost.
              </p>

              <label className="form-checkbox-label" style={{ fontSize: '0.8rem' }}>
                <input
                  type="checkbox"
                  className="form-checkbox"
                  checked={forceDelete}
                  onChange={(e) => setForceDelete(e.target.checked)}
                  disabled={deleting}
                />
                <span>Force delete (handles modified files)</span>
              </label>

              {error && (
                <div style={{ color: 'var(--accent-red)', fontSize: '0.78rem', wordBreak: 'break-word' }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-action danger"
                  style={{ flex: 1, padding: '6px', fontSize: '0.8rem' }}
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Removing...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  className="btn-action secondary"
                  style={{ flex: 1, padding: '6px', fontSize: '0.8rem' }}
                  onClick={() => {
                    setShowConfirm(false);
                    setError(null);
                  }}
                  disabled={deleting}
                >
                  Cancel
                </button>
              </div>
            </div>
          )
        )}
      </div>
      </div>
    </div>
  );
};
