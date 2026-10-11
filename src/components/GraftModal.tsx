import React, { useState, useEffect } from 'react';
import { X, Loader2, GitBranch } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { ApplyEntry, FileResult, LinkMode, RepoFiles } from '../types';
import { FilePicker, FileResults, useFileSelection } from './FilePicker';
import { toDisplayPath, resolveWorktreeBase, lastSegment } from '../utils/path';

const BRANCH_PREFIX = 'feature/';

interface GraftModalProps {
  repoPath: string;
  homeDir: string | null;
  worktreeDir: string;
  // Per-repo base branch override; unset means use the repo's GitHub default.
  defaultBranch?: string;
  files: RepoFiles;
  linkModes: { agent: LinkMode; env: LinkMode };
  onClose: () => void;
  onSubmit: (
    path: string,
    branch: string,
    newBranch: boolean,
    baseBranch: string | undefined,
    files: ApplyEntry[]
  ) => Promise<FileResult[]>;
}

export const GraftModal: React.FC<GraftModalProps> = ({
  repoPath,
  homeDir,
  worktreeDir,
  defaultBranch,
  files,
  linkModes,
  onClose,
  onSubmit,
}) => {
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileResult[] | null>(null);
  const selection = useFileSelection(files, linkModes);

  // Form states
  const [path, setPath] = useState('');
  const [isNewBranch, setIsNewBranch] = useState(true);
  const [newBranchName, setNewBranchName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [existingBranch, setExistingBranch] = useState('');

  const isAbsolutePath = path.trim().startsWith('/');
  const fullPath = isAbsolutePath
    ? path.trim()
    : `${resolveWorktreeBase(repoPath, worktreeDir, homeDir)}/${path.trim()}`;
  const previewPath = toDisplayPath(path.trim() ? fullPath : `${fullPath}[folder-name]`, homeDir);

  // The branch name follows the worktree name until the user types their own.
  const worktreeName = lastSegment(path.trim()).replace(/\s+/g, '-');
  const suggestedBranch = worktreeName ? `${BRANCH_PREFIX}${worktreeName}` : '';

  useEffect(() => {
    const fetchBranches = async () => {
      try {
        const [list, githubDefault] = await Promise.all([
          invoke<string[]>('get_git_branches', { repoPath }),
          defaultBranch
            ? Promise.resolve(null)
            : invoke<string | null>('get_default_branch', { repoPath }).catch(() => null),
        ]);
        setBranches(list);
        if (list.length > 0) {
          // Repo override, then GitHub's default, then main/master, then anything.
          const find = (name?: string | null) =>
            name ? list.find((b) => b === name) ?? list.find((b) => b === `origin/${name}`) : undefined;
          const base =
            find(defaultBranch) ??
            find(githubDefault) ??
            list.find((b) => ['main', 'master', 'origin/main', 'origin/master'].includes(b)) ??
            list[0];
          setBaseBranch(base);
          setExistingBranch(base);
        }
      } catch (err: any) {
        setError(err?.toString() || 'Failed to fetch branches');
      } finally {
        setLoadingBranches(false);
      }
    };
    fetchBranches();
  }, [repoPath, defaultBranch]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError('Path/folder name is required');
      return;
    }

    const branchToUse = isNewBranch ? newBranchName.trim() || suggestedBranch : existingBranch;
    if (!branchToUse) {
      setError(isNewBranch ? 'New branch name is required' : 'An existing branch must be selected');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await onSubmit(
        fullPath,
        branchToUse,
        isNewBranch,
        isNewBranch ? baseBranch : undefined,
        selection.build()
      );
      // Surface skipped files instead of closing; a clean run just closes.
      if (res.some((r) => r.status === 'skipped')) setResults(res);
      else onClose();
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

        {results ? (
          <>
            <span className="form-help">The worktree was created, but some files were not added:</span>
            <FileResults results={results} />
            <div className="modal-footer">
              <button type="button" className="btn-add" style={{ width: 'auto', padding: '10px 24px' }} onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : loadingBranches ? (
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
                Will be created in:<br />
                <span className="mono" style={{ fontSize: '0.8rem', color: '#fff' }}>{previewPath}</span>
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
                    placeholder={suggestedBranch || `${BRANCH_PREFIX}something-awesome`}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    disabled={submitting}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <span className="form-help">Leave blank to use the worktree name.</span>
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

            <FilePicker files={files} selection={selection} disabled={submitting} />

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
