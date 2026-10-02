import React, { useState } from 'react';
import { Plus, Trash2, X, Check, Loader2, FolderOpen, Settings } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { toDisplayPath } from '../utils/path';

interface SidebarProps {
  repos: string[];
  activeRepo: string | null;
  onSelectRepo: (repo: string) => void;
  onAddRepo: (path: string) => Promise<void>;
  onRemoveRepo: (path: string) => Promise<void>;
  homeDir: string | null;
  onOpenSettings: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  repos,
  activeRepo,
  onSelectRepo,
  onAddRepo,
  onRemoveRepo,
  homeDir,
  onOpenSettings,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const getRepoName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  const handlePickFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Git Repository',
      });
      if (selected && typeof selected === 'string') {
        setNewPath(selected);
      }
    } catch (err) {
      console.error('Folder picker error:', err);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPath.trim()) return;

    setLoading(true);
    setError(null);
    try {
      await onAddRepo(newPath.trim());
      setNewPath('');
      setIsAdding(false);
    } catch (err: any) {
      setError(err?.toString() || 'Failed to add repository');
    } finally {
      setLoading(false);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <img src="/logo.png" alt="Arbor" className="logo-icon" style={{ width: 28, height: 28, objectFit: 'contain' }} />
        <span className="logo-text">Arbor</span>
        <button
          type="button"
          className="btn-settings"
          onClick={onOpenSettings}
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={18} />
        </button>
      </div>

      <div className="repo-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', paddingRight: '8px' }}>
          <h3 className="section-title" style={{ margin: 0 }}>Repositories</h3>
        </div>
        
        {repos.length === 0 ? (
          <div style={{ padding: '0 8px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No repositories tracked yet. Track one below.
          </div>
        ) : (
          repos.map((repo) => {
            const isActive = repo === activeRepo;
            const displayPath = toDisplayPath(repo, homeDir);
            
            return (
              <div
                key={repo}
                className={`repo-item ${isActive ? 'active' : ''}`}
                onClick={() => onSelectRepo(repo)}
              >
                <div className="repo-details">
                  <span className="repo-name">{getRepoName(repo)}</span>
                  <span className="repo-path">{displayPath}</span>
                </div>
                <button
                  type="button"
                  className="btn-repo-action"
                  title="Open folder"
                  aria-label="Open folder"
                  onClick={(e) => {
                    e.stopPropagation();
                    invoke('open_folder', { path: repo }).catch((err) => console.error('Failed to open folder:', err));
                  }}
                >
                  <FolderOpen size={16} />
                </button>
                <button
                  type="button"
                  className="btn-remove-repo"
                  title="Remove from Arbor (Does not delete directory)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRepo(repo);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="sidebar-footer">
        {isAdding ? (
          <form onSubmit={handleAdd} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="repo-path">
                Repository Path
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  id="repo-path"
                  type="text"
                  className="form-input"
                  placeholder="/Users/name/projects/my-repo"
                  value={newPath}
                  onChange={(e) => {
                    setNewPath(e.target.value);
                    setError(null);
                  }}
                  disabled={loading}
                  autoFocus
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  className="btn-action secondary"
                  style={{ width: '42px', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  title="Pick folder from disk"
                  onClick={handlePickFolder}
                  disabled={loading}
                >
                  <FolderOpen size={16} />
                </button>
              </div>
            </div>
            
            {error && (
              <div style={{ color: 'var(--accent-red)', fontSize: '0.8rem', wordBreak: 'break-word', padding: '0 4px' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button
                type="submit"
                className="btn-add"
                style={{ flex: 1, padding: '8px', fontSize: '0.85rem' }}
                disabled={loading}
              >
                {loading ? <Loader2 className="loading-spinner" size={14} /> : <Check size={14} />}
                <span>Track</span>
              </button>
              <button
                type="button"
                className="btn-action secondary"
                style={{ width: '40px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onClick={() => {
                  setIsAdding(false);
                  setNewPath('');
                  setError(null);
                }}
                disabled={loading}
              >
                <X size={14} />
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn-add"
            onClick={() => setIsAdding(true)}
          >
            <Plus size={18} />
            <span>Track Git Repo</span>
          </button>
        )}
      </div>
    </aside>
  );
};
