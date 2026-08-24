import React, { useState, useEffect } from 'react';
import { X, Loader2, GitBranch } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

interface GraftModalProps {
  repoPath: string;
  onClose: () => void;
  onSubmit: (path: string, branch: string, newBranch: boolean, baseBranch?: string) => Promise<void>;
}

export const GraftModal: React.FC<GraftModalProps> = ({
  repoPath,
  onClose,
  onSubmit,
}) => {
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form states
  const [path, setPath] = useState('');
  const [isNewBranch, setIsNewBranch] = useState(true);
  const [newBranchName, setNewBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [existingBranch, setExistingBranch] = useState('');

  // Find parent folder of the repo to show in the helper text
  const parentFolder = repoPath.substring(0, repoPath.lastIndexOf('/')) || 'parent folder';

  useEffect(() => {
    const fetchBranches = async () => {
      try {
        const list: string[] = await invoke('get_git_branches', { repoPath });
        setBranches(list);
        if (list.length > 0) {
          // Set defaults - prioritize main or master
          const defaultBranch = list.find((b) => 
            b === 'main' || 
            b === 'master' || 
            b === 'origin/main' || 
            b === 'origin/master'
          ) || list[0];
          setBaseBranch(defaultBranch);
          setExistingBranch(defaultBranch);
        }
      } catch (err: any) {
        setError(err?.toString() || 'Failed to fetch branches');
      } finally {
        setLoadingBranches(false);
      }
    };
    fetchBranches();
  }, [repoPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError('Path/folder name is required');
      return;
    }

    const branchToUse = isNewBranch ? newBranchName.trim() : existingBranch;
    if (!branchToUse) {
      setError(isNewBranch ? 'New branch name is required' : 'An existing branch must be selected');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(
        path.trim(),
        branchToUse,
        isNewBranch,
        isNewBranch ? baseBranch : undefined
      );
      onClose();
    } catch (err: any) {
      setError(err?.toString() || 'Failed to create worktree');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Graft a New Branch</h2>
          <button type="button" className="panel-close" onClick={onClose} disabled={submitting}>
            <X size={18} />
          </button>
        </div>

        {loadingBranches ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 0', gap: '12px' }}>
            <Loader2 className="loading-spinner" size={32} style={{ color: 'var(--accent-green)' }} />
            <span style={{ color: 'var(--text-muted)' }}>Retrieving git branches...</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Folder / Path input */}
            <div className="form-group">
              <label className="form-label" htmlFor="graft-path">
                Worktree Path / Folder Name
              </label>
              <input
                id="graft-path"
                type="text"
                className="form-input"
                placeholder="my-worktree-folder"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={submitting}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <span className="form-help">
                Relative folder names will be created in:<br />
                <span className="mono" style={{ fontSize: '0.8rem', color: '#fff' }}>{parentFolder}/{path || '[folder-name]'}</span>
              </span>
            </div>

            {/* Toggle: New vs Existing */}
            <div className="form-group" style={{ margin: '4px 0' }}>
              <label className="form-checkbox-label">
                <input
                  type="checkbox"
                  className="form-checkbox"
                  checked={isNewBranch}
                  onChange={(e) => {
                    setIsNewBranch(e.target.checked);
                    setError(null);
                  }}
                  disabled={submitting}
                />
                <span>Create a new branch from a base branch</span>
              </label>
            </div>

            {isNewBranch ? (
              <>
                {/* New branch name */}
                <div className="form-group">
                  <label className="form-label" htmlFor="new-branch-name">
                    New Branch Name
                  </label>
                  <input
                    id="new-branch-name"
                    type="text"
                    className="form-input"
                    placeholder="feature/something-awesome"
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    disabled={submitting}
                  />
                </div>

                {/* Base branch select */}
                <div className="form-group">
                  <label className="form-label" htmlFor="base-branch">
                    Base Branch
                  </label>
                  <select
                    id="base-branch"
                    className="form-select"
                    value={baseBranch}
                    onChange={(e) => setBaseBranch(e.target.value)}
                    disabled={submitting}
                  >
                    {branches.map((b) => (
                      <option key={`base-${b}`} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            ) : (
              /* Existing branch select */
              <div className="form-group">
                <label className="form-label" htmlFor="existing-branch">
                  Select Existing Branch
                </label>
                {branches.length === 0 ? (
                  <div style={{ color: 'var(--accent-red)', fontSize: '0.85rem' }}>
                    No branches found to checkout.
                  </div>
                ) : (
                  <select
                    id="existing-branch"
                    className="form-select"
                    value={existingBranch}
                    onChange={(e) => setExistingBranch(e.target.value)}
                    disabled={submitting}
                  >
                    {branches.map((b) => (
                      <option key={`exist-${b}`} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {error && (
              <div style={{ color: 'var(--accent-red)', fontSize: '0.85rem', wordBreak: 'break-word', marginTop: '4px' }}>
                {error}
              </div>
            )}

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
                type="submit"
                className="btn-add"
                style={{ width: 'auto', padding: '10px 24px' }}
                disabled={submitting}
              >
                {submitting ? (
                  <>
                    <Loader2 className="loading-spinner" size={16} />
                    <span>Grafting...</span>
                  </>
                ) : (
                  <>
                    <GitBranch size={16} />
                    <span>Graft Branch</span>
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
