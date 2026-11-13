import React, { useState } from 'react';
import { X, Trash2, Loader2, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { WorktreeInfo } from '../types';
import { toDisplayPath } from '../utils/path';

interface Props {
  repoPath: string;
  // The worktrees the canvas filters currently show (never the main one).
  worktrees: WorktreeInfo[];
  homeDir: string | null;
  onDone: () => void;
  onClose: () => void;
}

// warn: the worktree went but its branch was kept.
type Outcome = { ok: boolean; warn?: boolean; message: string };

const folderName = (path: string) => path.split('/').pop() || path;

export const BulkRemoveModal: React.FC<Props> = ({ repoPath, worktrees, homeDir, onDone, onClose }) => {
  // Worktrees with uncommitted changes start unticked: removing them loses work.
  const [checked, setChecked] = useState(() => new Set(worktrees.filter((w) => w.is_clean).map((w) => w.path)));
  const [deleteBranches, setDeleteBranches] = useState(false);
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome> | null>(null);

  const chosen = worktrees.filter((w) => checked.has(w.path));
  const dirtyChosen = chosen.filter((w) => !w.is_clean).length;

  const toggle = (path: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // One at a time: git takes a lock on the repo for each worktree removal.
  const removeAll = async () => {
    setRunning(true);
    const results: Record<string, Outcome> = {};
    for (const wt of chosen) {
      try {
        await invoke('delete_worktree', { repoPath, worktreePath: wt.path, force: !wt.is_clean });
      } catch (err: any) {
        results[wt.path] = { ok: false, message: err?.toString() || 'Failed to remove worktree' };
        setOutcomes({ ...results });
        continue;
      }
      let message = 'Worktree removed';
      let warn = false;
      if (deleteBranches && wt.branch) {
        try {
          // Merged PRs are often squash-merged, which plain `-d` can't see, so
          // those are force-deleted; anything else only goes if git agrees
          // it's fully merged.
          await invoke('delete_branch', { repoPath, branch: wt.branch, force: wt.remote_status === 'merged' });
          message = 'Worktree and branch removed';
        } catch (err: any) {
          message = `Worktree removed, branch kept: ${err?.toString() || 'could not delete branch'}`;
          warn = true;
        }
      }
      results[wt.path] = { ok: true, warn, message };
      setOutcomes({ ...results });
    }
    setOutcomes({ ...results });
    setRunning(false);
    onDone();
  };

  const finished = outcomes !== null && !running;

  return (
    <div className="modal-overlay" onClick={running ? undefined : onClose}>
      <div className="modal-content bulk-remove-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Remove Worktrees</h2>
          <button type="button" className="panel-close" onClick={onClose} disabled={running} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <span className="form-help">
          These are the worktrees your current filters show. The main worktree is never included.
        </span>

        <div className="bulk-list">
          {worktrees.map((wt) => {
            const outcome = outcomes?.[wt.path];
            return (
              <label key={wt.path} className={`bulk-row ${outcome ? (!outcome.ok ? 'failed' : outcome.warn ? 'partial' : 'done') : ''}`}>
                {outcome ? (
                  outcome.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />
                ) : (
                  <input
                    type="checkbox"
                    className="form-checkbox"
                    checked={checked.has(wt.path)}
                    onChange={() => toggle(wt.path)}
                    disabled={running || outcomes !== null}
                  />
                )}
                <span className="bulk-row-text">
                  <span className="bulk-row-name">{wt.branch ?? folderName(wt.path)}</span>
                  <span className="bulk-row-path mono">{toDisplayPath(wt.path, homeDir)}</span>
                  {outcome ? (
                    <span className="bulk-row-note">{outcome.message}</span>
                  ) : (
                    !wt.is_clean && (
                      <span className="bulk-row-note warn">Uncommitted changes will be lost</span>
                    )
                  )}
                </span>
              </label>
            );
          })}
        </div>

        {!outcomes && (
          <>
            <label className="form-checkbox-label">
              <input
                type="checkbox"
                className="form-checkbox"
                checked={deleteBranches}
                onChange={(e) => setDeleteBranches(e.target.checked)}
              />
              Also delete the local branches
            </label>
            <span className="form-help">
              Merged branches are force-deleted. Others are only deleted if git sees them as fully merged, so unmerged
              work is kept. Remote branches are never touched.
            </span>
            {dirtyChosen > 0 && (
              <div className="bulk-warning">
                <AlertTriangle size={16} />
                <span>
                  {dirtyChosen} selected worktree{dirtyChosen === 1 ? ' has' : 's have'} uncommitted changes that will
                  be permanently lost.
                </span>
              </div>
            )}
          </>
        )}

        <div className="modal-footer">
          {finished ? (
            <button type="button" className="btn-add" style={{ width: 'auto', padding: '10px 24px' }} onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn-action secondary"
                style={{ width: 'auto', padding: '10px 20px' }}
                onClick={onClose}
                disabled={running}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-action danger"
                style={{ width: 'auto', padding: '10px 20px' }}
                onClick={removeAll}
                disabled={running || chosen.length === 0}
              >
                {running ? <Loader2 className="loading-spinner" size={16} /> : <Trash2 size={16} />}
                <span>
                  Remove {chosen.length} worktree{chosen.length === 1 ? '' : 's'}
                </span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
