import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, GitMerge, Loader2 } from 'lucide-react';
import { UpdateOutcome, WorktreeInfo } from '../types';

interface Props {
  worktree: WorktreeInfo;
  // e.g. develop; the details card hides this when there's no base or the
  // worktree is on the base branch itself.
  base: string;
  onOpenInEditor: (path: string) => void;
  onChanged: () => Promise<void>;
}

// Merge the base branch in, or rebase onto it. If that stops on conflicts the
// worktree is left mid-merge so they can be resolved in an editor, with
// Abort to back out.
export const UpdateFromBase: React.FC<Props> = ({ worktree, base, onOpenInEditor, onChanged }) => {
  const [busy, setBusy] = useState<'merge' | 'rebase' | 'abort' | null>(null);
  const [result, setResult] = useState<UpdateOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inProgress = worktree.operation;

  const update = async (rebase: boolean) => {
    setBusy(rebase ? 'rebase' : 'merge');
    setError(null);
    setResult(null);
    try {
      setResult(await invoke<UpdateOutcome>('update_from_base', { path: worktree.path, base, rebase }));
      await onChanged();
    } catch (err: any) {
      setError(err?.toString() || 'Update failed');
    } finally {
      setBusy(null);
    }
  };

  const abort = async () => {
    setBusy('abort');
    setError(null);
    try {
      await invoke('abort_update', { path: worktree.path });
      setResult(null);
      await onChanged();
    } catch (err: any) {
      setError(err?.toString() || 'Abort failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="detail-row">
      <span className="detail-label">Update from {base}</span>
      {inProgress ? (
        <div className="update-conflict">
          <div className="update-conflict-title">
            <AlertTriangle size={14} />
            <span>{inProgress === 'rebase' ? 'Rebase' : 'Merge'} in progress</span>
          </div>
          {result && !result.ok && result.conflicts.length > 0 && (
            <ul className="update-conflict-files mono">
              {result.conflicts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
          <span className="form-help">
            Resolve the conflicts in your editor and finish the {inProgress} there, or abort to put the branch back how
            it was.
          </span>
          <div className="sync-buttons">
            <button type="button" className="btn-sync" onClick={() => onOpenInEditor(worktree.path)}>
              Open editor
            </button>
            <button type="button" className="btn-sync danger" onClick={abort} disabled={busy !== null}>
              {busy === 'abort' ? <Loader2 size={14} className="loading-spinner" /> : null}
              <span>Abort {inProgress}</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="sync-buttons">
          <button
            type="button"
            className="btn-sync"
            onClick={() => update(false)}
            disabled={busy !== null || !worktree.is_clean}
            title={worktree.is_clean ? `git merge origin/${base}` : 'Commit or stash your changes first'}
          >
            {busy === 'merge' ? <Loader2 size={14} className="loading-spinner" /> : <GitMerge size={14} />}
            <span>Merge in</span>
          </button>
          <button
            type="button"
            className="btn-sync"
            onClick={() => update(true)}
            disabled={busy !== null || !worktree.is_clean}
            title={worktree.is_clean ? `git rebase origin/${base}` : 'Commit or stash your changes first'}
          >
            {busy === 'rebase' ? <Loader2 size={14} className="loading-spinner" /> : <GitMerge size={14} />}
            <span>Rebase onto</span>
          </button>
        </div>
      )}
      {result?.ok && <span className="sync-feedback success">{result.message}</span>}
      {error && <span className="sync-feedback error">{error}</span>}
    </div>
  );
};
