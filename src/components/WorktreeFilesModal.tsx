import React, { useState } from 'react';
import { X, Loader2, FilePlus } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { FileResult, LinkMode, RepoFiles } from '../types';
import { FilePicker, FileResults, useFileSelection } from './FilePicker';

interface Props {
  repoPath: string;
  worktreePath: string;
  files: RepoFiles;
  linkModes: { agent: LinkMode; env: LinkMode };
  exclude: boolean;
  // Called once files were applied, so the tree can refresh its git status.
  onApplied: () => void;
  onClose: () => void;
}

// Adds configured agent/env files to a worktree that already exists.
export const WorktreeFilesModal: React.FC<Props> = ({
  repoPath,
  worktreePath,
  files,
  linkModes,
  exclude,
  onApplied,
  onClose,
}) => {
  const selection = useFileSelection(files, linkModes);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = selection.build();

  const apply = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res: FileResult[] = await invoke('apply_worktree_files', {
        repoPath,
        worktreePath,
        entries: chosen,
        exclude,
      });
      setResults(res);
      onApplied();
    } catch (err: any) {
      setError(err?.toString() || 'Failed to add files');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Add Files to Worktree</h2>
          <button type="button" className="panel-close" onClick={onClose} disabled={submitting}>
            <X size={18} />
          </button>
        </div>

        {results ? (
          <>
            <FileResults results={results} />
            <div className="modal-footer">
              <button type="button" className="btn-add" style={{ width: 'auto', padding: '10px 24px' }} onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <FilePicker files={files} selection={selection} disabled={submitting} />
            <span className="form-help">Existing files at the target path are replaced.</span>
            {error && <div style={{ color: 'var(--accent-red)', fontSize: '0.85rem' }}>{error}</div>}
            <div className="modal-footer">
              <button
                type="button"
                className="btn-action secondary"
                style={{ width: 'auto', padding: '10px 20px' }}
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-add"
                style={{ width: 'auto', padding: '10px 24px' }}
                onClick={apply}
                disabled={submitting || chosen.length === 0}
              >
                {submitting ? <Loader2 className="loading-spinner" size={16} /> : <FilePlus size={16} />}
                <span>Add {chosen.length || ''} file{chosen.length === 1 ? '' : 's'}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
