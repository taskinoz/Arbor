import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TreeCanvas } from './components/TreeCanvas';
import { DetailsPanel } from './components/DetailsPanel';
import { GraftModal } from './components/GraftModal';
import { WorktreeInfo } from './types';
import { invoke } from '@tauri-apps/api/core';
import { GitFork, RefreshCw, Plus, Sparkles } from 'lucide-react';
import './App.css';

function App() {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [selectedWt, setSelectedWt] = useState<WorktreeInfo | null>(null);
  const [popupSide, setPopupSide] = useState<'left' | 'right'>('right');

  // Settings states
  const [showFullPath, setShowFullPath] = useState(false);

  // Loading states
  const [isLoadingWorktrees, setIsLoadingWorktrees] = useState(false);
  
  // Modal toggle
  const [showGraftModal, setShowGraftModal] = useState(false);

  // Load repositories on mount
  useEffect(() => {
    const fetchRepos = async () => {
      try {
        const list: string[] = await invoke('get_repos');
        setRepos(list);
        if (list.length > 0) {
          setActiveRepo(list[0]);
        }
      } catch (err) {
        console.error('Failed to load repositories:', err);
      }
    };
    fetchRepos();
  }, []);

  // Fetch worktrees whenever the active repository changes
  useEffect(() => {
    if (!activeRepo) {
      setWorktrees([]);
      setSelectedWt(null);
      return;
    }
    loadWorktrees(activeRepo);
  }, [activeRepo]);

  const loadWorktrees = async (repoPath: string, preserveSelection = false) => {
    setIsLoadingWorktrees(true);
    const previousSelectedPath = preserveSelection ? selectedWt?.path : null;
    if (!preserveSelection) setSelectedWt(null);
    try {
      const list: WorktreeInfo[] = await invoke('get_worktrees', { repoPath });
      setWorktrees(list);
      // If we're refreshing in place (e.g. after a fetch/pull), keep the same
      // worktree selected/open rather than jumping the popover to the root.
      const stillSelected = previousSelectedPath
        ? list.find((w) => w.path === previousSelectedPath)
        : null;
      if (stillSelected) {
        setSelectedWt(stillSelected);
        return;
      }
      // Select the main repository worktree by default if it exists
      const main = list.find((w) => w.is_main);
      if (main) {
        setSelectedWt(main);
      } else if (list.length > 0) {
        setSelectedWt(list[0]);
      }
    } catch (err) {
      console.error('Failed to load worktrees:', err);
      setWorktrees([]);
    } finally {
      setIsLoadingWorktrees(false);
    }
  };

  const handleSelectRepo = (repoPath: string) => {
    setActiveRepo(repoPath);
  };

  const handleAddRepo = async (repoPath: string) => {
    const list: string[] = await invoke('add_repo', { path: repoPath });
    setRepos(list);
    setActiveRepo(repoPath); // Switch to the newly added repo
  };

  const handleRemoveRepo = async (repoPath: string) => {
    const list: string[] = await invoke('remove_repo', { path: repoPath });
    setRepos(list);
    if (activeRepo === repoPath) {
      // If we removed the active repo, select another one
      setActiveRepo(list.length > 0 ? list[0] : null);
    }
  };

  const handleOpenInCode = async (path: string) => {
    try {
      await invoke('open_in_vscode', { path });
    } catch (err: any) {
      alert(err?.toString() || 'Failed to open in VS Code');
    }
  };

  const handleDeleteWorktree = async (path: string, force: boolean) => {
    if (!activeRepo) return;
    await invoke('delete_worktree', { repoPath: activeRepo, worktreePath: path, force });
    // Refresh worktree list. Preserve the current selection reference so the
    // panel doesn't blink to "nothing selected" mid-refresh (the deleted
    // worktree naturally won't be found afterwards, so it falls back to the
    // main worktree once the new list arrives).
    await loadWorktrees(activeRepo, true);
  };

  const handleGraftSubmit = async (
    path: string,
    branch: string,
    newBranch: boolean,
    baseBranch?: string
  ) => {
    if (!activeRepo) return;
    await invoke('create_worktree', {
      repoPath: activeRepo,
      path,
      branch,
      newBranch,
      baseBranch,
    });
    // Refresh worktree list
    await loadWorktrees(activeRepo);
  };

  const handleSelectWt = (wt: WorktreeInfo, side: 'left' | 'right') => {
    setSelectedWt(wt);
    // Open the popover on the opposite side of the screen from the clicked node
    // so it never covers the node (or its neighbors) that was just selected.
    setPopupSide(side === 'right' ? 'left' : 'right');
  };

  const getRepoName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  return (
    <div className="arbor-layout">
      {/* Sidebar Section */}
      <Sidebar
        repos={repos}
        activeRepo={activeRepo}
        onSelectRepo={handleSelectRepo}
        onAddRepo={handleAddRepo}
        onRemoveRepo={handleRemoveRepo}
        showFullPath={showFullPath}
        onToggleFullPath={() => setShowFullPath(!showFullPath)}
      />

      {/* Main Dashboard Section */}
      <main className="main-content">
        {activeRepo ? (
          <>
            {/* Header / Topbar */}
            <header className="top-bar">
              <div className="repo-title-info">
                <span className="repo-active-name">{getRepoName(activeRepo)}</span>
                <span className="repo-active-path" title={activeRepo}>
                  {activeRepo}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
                <button
                  type="button"
                  className="btn-graft"
                  style={{ padding: '10px 20px', border: '1px solid rgba(255,255,255,0.08)' }}
                  onClick={() => loadWorktrees(activeRepo)}
                  disabled={isLoadingWorktrees}
                  title="Refresh Git Worktrees"
                >
                  <RefreshCw size={16} className={isLoadingWorktrees ? 'loading-spinner' : ''} />
                  <span>Refresh</span>
                </button>
              </div>
            </header>

            {/* Tree visualization Area */}
            <TreeCanvas
              worktrees={worktrees}
              selectedWt={selectedWt}
              onSelectWt={handleSelectWt}
              isLoading={isLoadingWorktrees}
            />

            {/* Floating button to Graft new branches */}
            {!isLoadingWorktrees && worktrees.length > 0 && (
              <div className="canvas-actions">
                <button
                  type="button"
                  className="btn-graft"
                  onClick={() => setShowGraftModal(true)}
                >
                  <Plus size={16} />
                  <span>Graft Branch</span>
                </button>
              </div>
            )}

            {/* Details Panel Drawer */}
            {selectedWt && (
              <DetailsPanel
                worktree={selectedWt}
                side={popupSide}
                onClose={() => setSelectedWt(null)}
                onOpenInCode={handleOpenInCode}
                onDeleteWorktree={handleDeleteWorktree}
                onRefresh={() => loadWorktrees(activeRepo, true)}
              />
            )}

            {/* Graft Modal Dialog */}
            {showGraftModal && (
              <GraftModal
                repoPath={activeRepo}
                onClose={() => setShowGraftModal(false)}
                onSubmit={handleGraftSubmit}
              />
            )}
          </>
        ) : (
          /* Empty dashboard state */
          <div className="empty-state">
            <GitFork className="empty-icon" size={64} />
            <h2 className="empty-title">Track a Repository</h2>
            <p className="empty-desc">
              Get started by adding an existing Git repository from your local drive. 
              Arbor will display your worktrees as branches of a digital tree.
            </p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--accent-green)', fontSize: '0.9rem' }}>
              <Sparkles size={16} />
              <span>Glows indicate git clean state (green) or modified changes (amber).</span>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
