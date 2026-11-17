import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { ChevronDown, Loader2, RefreshCcw, X } from 'lucide-react';
import { SyncResult } from '../types';
import { toDisplayPath } from '../utils/path';

interface Props {
  repoPath: string;
  homeDir: string | null;
  onDone: () => Promise<void>;
}

const LABEL: Record<SyncResult['outcome'], string> = {
  pulled: 'Pulled',
  up_to_date: 'Up to date',
  skipped: 'Skipped',
  failed: 'Failed',
};

// One fetch for the whole repo (worktrees share remote refs), then optionally
// fast-forward every clean worktree that's behind.
export const SyncAllMenu: React.FC<Props> = ({ repoPath, homeDir, onDone }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'fetch' | 'pull' | null>(null);
  const [results, setResults] = useState<SyncResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const sync = async (pull: boolean) => {
    setOpen(false);
    setBusy(pull ? 'pull' : 'fetch');
    setError(null);
    try {
      const res = await invoke<SyncResult[]>('sync_all', { repoPath, pull });
      if (pull) setResults(res);
      await onDone();
    } catch (err: any) {
      setError(err?.toString() || 'Sync failed');
    } finally {
      setBusy(null);
    }
  };

  // Most interesting first: what changed, then what needs attention.
  const order = { pulled: 0, failed: 1, skipped: 2, up_to_date: 3 };
  const sorted = results ? [...results].sort((a, b) => order[a.outcome] - order[b.outcome]) : [];

  return (
    <div className="runs-menu" ref={ref}>
      <button
        type="button"
        className="runs-menu-button"
        onClick={() => setOpen(!open)}
        disabled={busy !== null}
        title="Fetch or pull every worktree"
      >
        {busy ? <Loader2 size={14} className="loading-spinner" /> : <RefreshCcw size={14} />}
        <span>{busy === 'pull' ? 'Pulling…' : busy === 'fetch' ? 'Fetching…' : 'Sync'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="runs-menu-list" style={{ width: 280 }}>
          <button type="button" className="runs-menu-item" onClick={() => sync(false)}>
            <span className="runs-menu-command">Fetch all</span>
            <span className="runs-menu-meta">Update remote branches and ahead/behind counts</span>
          </button>
          <button type="button" className="runs-menu-item" onClick={() => sync(true)}>
            <span className="runs-menu-command">Fetch & pull all</span>
            <span className="runs-menu-meta">Fast-forward clean worktrees that are behind</span>
          </button>
        </div>
      )}
      {error && (
        <div className="runs-menu-list sync-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* Portalled out: the top bar's backdrop-filter would otherwise become
          the containing block for this fixed overlay and squash it into the bar. */}
      {results && createPortal(
        <div className="modal-overlay" onClick={() => setResults(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">Pull All</h2>
              <button type="button" className="panel-close" onClick={() => setResults(null)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <span className="form-help">
              Worktrees with uncommitted changes or their own unpushed commits are left alone, so nothing needs a merge.
            </span>
            <div className="bulk-list">
              {sorted.map((r) => (
                <div key={r.path} className={`bulk-row sync-${r.outcome}`}>
                  <span className="bulk-row-text">
                    <span className="bulk-row-name">{r.branch ?? 'Detached HEAD'}</span>
                    <span className="bulk-row-path mono">{toDisplayPath(r.path, homeDir)}</span>
                    <span className="bulk-row-note">
                      {r.outcome === 'pulled' || r.outcome === 'up_to_date' ? r.message : `${LABEL[r.outcome]} · ${r.message}`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-add" style={{ width: 'auto', padding: '10px 24px' }} onClick={() => setResults(null)}>
                Done
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
