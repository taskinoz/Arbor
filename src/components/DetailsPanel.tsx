import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { WorktreeInfo, SyncStatus } from '../types';
import { toDisplayPath } from '../utils/path';
import { formatBytes, timeAgo } from '../utils/time';
import { PrBadges } from './PrBadges';
import { Run } from '../runs';
import { SavedCommand } from '../settings';
import { runStatusText } from './RunsMenu';
import { UpdateFromBase } from './UpdateFromBase';
import {
  X,
  Code,
  Trash2,
  AlertTriangle,
  Copy,
  Lock,
  LockOpen,
  FolderX,
  Check,
  Download,
  ArrowDown,
  ArrowUp,
  Loader2,
  FilePlus,
  Terminal,
  SquareTerminal,
  Play,
  Square,
} from 'lucide-react';

type SyncAction = 'fetch' | 'pull' | 'push' | null;

interface DetailsPanelProps {
  worktree: WorktreeInfo;
  repoPath: string;
  // The repo's base branch (e.g. develop), for "update from base".
  baseBranch: string | null;
  side: 'left' | 'right';
  homeDir: string | null;
  onClose: () => void;
  editorLabel: string | null;
  onOpenInEditor: (path: string) => Promise<void>;
  onAddFiles?: () => void;
  onRunCommand: () => void;
  terminalLabel: string | null;
  onOpenInTerminal: (path: string) => Promise<void>;
  // The repo's one-click commands, and this worktree's runs.
  savedCommands: SavedCommand[];
  runs: Run[];
  onRunSaved: (command: string) => void;
  onViewRun: (run: Run) => void;
  onStopRun: (id: string) => void;
  onDismissRun: (id: string) => void;
  onDeleteWorktree: (path: string, force: boolean) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const sizeCache = new Map<string, number>();

export const DetailsPanel: React.FC<DetailsPanelProps> = ({
  worktree,
  repoPath,
  baseBranch,
  side,
  homeDir,
  onClose,
  editorLabel,
  onOpenInEditor,
  onAddFiles,
  onRunCommand,
  terminalLabel,
  onOpenInTerminal,
  savedCommands,
  runs,
  onRunSaved,
  onViewRun,
  onStopRun,
  onDismissRun,
  onDeleteWorktree,
  onRefresh,
}) => {
  const [showConfirm, setShowConfirm] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [branchCopied, setBranchCopied] = useState(false);
  const [shaCopied, setShaCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tidyBusy, setTidyBusy] = useState(false);
  const [tidyError, setTidyError] = useState<string | null>(null);
  const locked = worktree.locked !== null;

  // Lock/unlock and prune are quick local git calls, then a refresh.
  const tidy = async (command: string, args: Record<string, unknown>) => {
    setTidyBusy(true);
    setTidyError(null);
    try {
      await invoke(command, { repoPath, ...args });
      await onRefresh();
    } catch (err: any) {
      setTidyError(err?.toString() || 'Failed');
    } finally {
      setTidyBusy(false);
    }
  };

  // PR info comes from the background remote pass: undefined while it's
  // still loading, null when the branch has no PR.
  const pr = worktree.pr;
  const prLoading = pr === undefined && !!worktree.branch;

  // Size on disk is a full directory walk (node_modules can be huge), so it's
  // only calculated on request and remembered for the session.
  const [size, setSize] = useState<number | 'loading' | null>(() => sizeCache.get(worktree.path) ?? null);
  useEffect(() => setSize(sizeCache.get(worktree.path) ?? null), [worktree.path]);
  const calculateSize = async () => {
    const path = worktree.path;
    setSize('loading');
    try {
      const bytes = await invoke<number>('get_dir_size', { path });
      sizeCache.set(path, bytes);
      if (path === worktree.path) setSize(bytes);
    } catch {
      setSize(null);
    }
  };

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
        </div>
      </div>

      {!worktree.missing && (<>
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

      {baseBranch && worktree.branch && worktree.branch !== baseBranch && (
        <UpdateFromBase
          worktree={worktree}
          base={baseBranch}
          onOpenInEditor={onOpenInEditor}
          onChanged={onRefresh}
        />
      )}

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

      </>)}

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

      {worktree.branch && (
        <div className="detail-row">
          <span className="detail-label">Pull Request</span>
          {prLoading ? (
            <span className="sync-status-text muted">Checking…</span>
          ) : pr ? (
            <button type="button" className="pr-link" onClick={() => openUrl(pr.url)} title="Open on GitHub">
              <PrBadges pr={pr} />
            </button>
          ) : (
            <span className="sync-status-text muted">No pull request</span>
          )}
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

      {!worktree.missing && (<>
      <div className="detail-row">
        <span className="detail-label">Size on Disk</span>
        {typeof size === 'number' ? (
          <span className="detail-value">
            {formatBytes(size)}{' '}
            <button type="button" className="link-button" onClick={calculateSize}>Recalculate</button>
          </span>
        ) : (
          <button type="button" className="link-button" onClick={calculateSize} disabled={size === 'loading'}>
            {size === 'loading' ? 'Calculating…' : 'Calculate'}
          </button>
        )}
      </div>

      </>)}

      <div className="detail-row">
        <span className="detail-label">Last Commit</span>
        {worktree.last_commit ? (
          <div className="last-commit">
            <span className="last-commit-subject">{worktree.last_commit.subject}</span>
            <span className="last-commit-meta">
              {worktree.last_commit.author} · {timeAgo(worktree.last_commit.time_ms)} ·{' '}
              <span className="mono" title={worktree.head}>{worktree.head.slice(0, 8)}</span>
              <button
                type="button"
                className="sha-copy"
                title="Copy full commit hash"
                onClick={() => {
                  navigator.clipboard.writeText(worktree.head);
                  setShaCopied(true);
                  setTimeout(() => setShaCopied(false), 2000);
                }}
              >
                {shaCopied ? <Check size={12} style={{ color: 'var(--accent-green)' }} /> : <Copy size={12} />}
              </button>
            </span>
          </div>
        ) : (
          <span className="detail-value mono" style={{ fontSize: '0.8rem' }}>{worktree.head}</span>
        )}
      </div>

      {worktree.missing ? (
      <div className="panel-actions">
        <div className="update-conflict">
          <div className="update-conflict-title">
            <FolderX size={14} />
            <span>Folder missing</span>
          </div>
          <span className="form-help">
            This worktree's folder was deleted outside Arbor, so git still lists it. Pruning removes the leftover entry;
            the branch is kept.
          </span>
          <button
            type="button"
            className="btn-sync"
            onClick={() => tidy('prune_worktrees', {})}
            disabled={tidyBusy}
          >
            {tidyBusy ? <Loader2 size={14} className="loading-spinner" /> : null}
            <span>Prune missing worktrees</span>
          </button>
          {tidyError && <span className="sync-feedback error">{tidyError}</span>}
        </div>
      </div>
      ) : (
      <div className="panel-actions">
        <button
          type="button"
          className="btn-action primary"
          onClick={() => onOpenInEditor(worktree.path)}
          disabled={!editorLabel}
          title={editorLabel ? undefined : 'No supported editor found - see Settings'}
        >
          <Code size={16} />
          <span>{editorLabel ? `Open in ${editorLabel}` : 'No editor found'}</span>
        </button>

        <div className="panel-action-pair">
          <button
            type="button"
            className="btn-action secondary"
            onClick={() => onOpenInTerminal(worktree.path)}
            disabled={!terminalLabel}
            title={terminalLabel ? `Open in ${terminalLabel}` : 'No supported terminal found'}
          >
            <SquareTerminal size={16} />
            <span>{terminalLabel ?? 'No terminal'}</span>
          </button>
          <button type="button" className="btn-action secondary" onClick={onRunCommand}>
            <Terminal size={16} />
            <span>Run</span>
          </button>
        </div>

        {savedCommands.length > 0 && (
          <div className="saved-commands">
            {savedCommands.map((c) => {
              // A second click shows the running one rather than starting a duplicate dev server.
              const live = runs.find((r) => r.command === c.command && r.status.kind === 'running');
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`saved-command ${live ? 'running' : ''}`}
                  title={c.command}
                  onClick={() => (live ? onViewRun(live) : onRunSaved(c.command))}
                >
                  {live ? <Loader2 size={12} className="loading-spinner" /> : <Play size={12} />}
                  <span>{c.name || c.command}</span>
                </button>
              );
            })}
          </div>
        )}

        {runs.length > 0 && (
          <div className="worktree-runs">
            {runs.map((run) => (
              <div key={run.id} className="worktree-run">
                <button type="button" className="worktree-run-main" onClick={() => onViewRun(run)} title="Show output">
                  <span className="mono">{run.command}</span>
                  <span className={`run-state ${run.status.kind}`}>{runStatusText(run)}</span>
                </button>
                {run.status.kind === 'running' ? (
                  <button type="button" className="panel-close" title="Stop" onClick={() => onStopRun(run.id)}>
                    <Square size={13} />
                  </button>
                ) : (
                  <button type="button" className="panel-close" title="Dismiss" onClick={() => onDismissRun(run.id)}>
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {onAddFiles && (
          <button type="button" className="btn-action secondary" onClick={onAddFiles}>
            <FilePlus size={16} />
            <span>Add agent / env files</span>
          </button>
        )}

        {!worktree.is_main && (
          !showConfirm ? (
            <>
              <div className="panel-action-pair">
                <button
                  type="button"
                  className="btn-action secondary"
                  onClick={() => tidy('set_worktree_locked', { worktreePath: worktree.path, locked: !locked })}
                  disabled={tidyBusy}
                  title={locked ? 'Allow this worktree to be removed again' : "Protect this worktree from being removed, including by bulk remove"}
                >
                  {locked ? <LockOpen size={16} /> : <Lock size={16} />}
                  <span>{locked ? 'Unlock' : 'Lock'}</span>
                </button>
                <button
                  type="button"
                  className="btn-action danger"
                  onClick={() => setShowConfirm(true)}
                  disabled={locked}
                  title={locked ? 'Unlock it first' : undefined}
                >
                  <Trash2 size={16} />
                  <span>Delete</span>
                </button>
              </div>
              {tidyError && <span className="sync-feedback error">{tidyError}</span>}
            </>
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
      )}
      </div>
    </div>
  );
};
