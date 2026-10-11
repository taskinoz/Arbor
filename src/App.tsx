import { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TreeCanvas } from './components/TreeCanvas';
import { DetailsPanel } from './components/DetailsPanel';
import { GraftModal } from './components/GraftModal';
import { ApplyEntry, Editor, FileResult, WorktreeInfo } from './types';
import { invoke } from '@tauri-apps/api/core';
import { GitFork, RefreshCw, Plus, Sparkles } from 'lucide-react';
import { toDisplayPath, resolveWorktreeBase } from './utils/path';
import { ThemeName, applyTheme, currentSeason } from './theme';
import { Settings, loadSettings, saveSettings } from './settings';
import { SettingsModal } from './components/SettingsModal';
import { WorktreeFilesModal } from './components/WorktreeFilesModal';
import { EMPTY_FILES, hasUsableFiles } from './components/FilePicker';
import './App.css';

function App() {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [selectedWt, setSelectedWt] = useState<WorktreeInfo | null>(null);
  const [popupSide, setPopupSide] = useState<'left' | 'right'>('right');
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [filesTarget, setFilesTarget] = useState<WorktreeInfo | null>(null);

  // Settings states
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [season, setSeason] = useState(currentSeason);
  const activeTheme: ThemeName = settings.autoTheme ? season : settings.theme;
  const updateSettings = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    applyTheme(activeTheme);
  }, [activeTheme]);

  // Auto mode re-checks the season hourly so a long-running session still
  // rolls over when the month does.
  useEffect(() => {
    if (!settings.autoTheme) return;
    const id = setInterval(() => setSeason(currentSeason()), 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [settings.autoTheme]);

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

    const fetchHomeDir = async () => {
      try {
        const home: string | null = await invoke('get_home_dir');
        setHomeDir(home);
      } catch (err) {
        console.error('Failed to load home directory:', err);
      }
    };
    fetchHomeDir();
    refreshEditors();
  }, []);

  const refreshEditors = async () => {
    try {
      setEditors(await invoke<Editor[]>('detect_editors'));
    } catch (err) {
      console.error('Failed to detect editors:', err);
    }
  };

  const editor = editors.find((e) => e.id === settings.openWith) ?? editors[0] ?? null;
  const repoFiles = (activeRepo && settings.repoFiles[activeRepo]) || EMPTY_FILES;
  const linkModes = { agent: settings.agentLinkMode, env: settings.envLinkMode };

  // Fetch worktrees whenever the active repository changes
  useEffect(() => {
    if (!activeRepo) {
      setWorktrees([]);
      setSelectedWt(null);
      return;
    }
    // Clear the tree immediately rather than leaving the previous repo's
    // (now stale) tree dimmed underneath a spinner - the canvas goes blank
    // with a loading throbber, then the new tree grows in once it arrives.
    setWorktrees([]);
    setSelectedWt(null);
    loadWorktrees(activeRepo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepo]);

  const loadWorktrees = async (repoPath: string, preserveSelection = false, selectBranch?: string) => {
    setIsLoadingWorktrees(true);
    const previousSelectedPath = preserveSelection ? selectedWt?.path : null;
    if (!preserveSelection) setSelectedWt(null);
    try {
      const list: WorktreeInfo[] = await invoke('get_worktrees', { repoPath });
      setWorktrees(list);
      // Just grafted a branch - select the worktree for it regardless of
      // whatever was selected before, so the new branch is front-and-center.
      if (selectBranch) {
        const grafted = list.find((w) => w.branch === selectBranch);
        if (grafted) {
          setSelectedWt(grafted);
          return;
        }
      }
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

  const handleOpenInEditor = async (path: string) => {
    if (!editor) return;
    try {
      await invoke('open_in_editor', { editorId: editor.id, path });
    } catch (err: any) {
      alert(err?.toString() || `Failed to open in ${editor.label}`);
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
    baseBranch: string | undefined,
    files: ApplyEntry[]
  ): Promise<FileResult[]> => {
    if (!activeRepo) return [];
    // When worktrees live inside the repo, hide that folder from git status.
    const base = resolveWorktreeBase(activeRepo, settings.worktreeDir, homeDir);
    const excludeDir =
      settings.excludeFromGit && base.startsWith(`${activeRepo}/`) ? base.slice(activeRepo.length + 1) : undefined;
    await invoke('create_worktree', {
      repoPath: activeRepo,
      path,
      branch,
      newBranch,
      baseBranch,
      excludeDir,
    });
    // The worktree exists now, so a failure adding files must not fail the graft.
    let results: FileResult[] = [];
    if (files.length > 0) {
      try {
        results = await invoke<FileResult[]>('apply_worktree_files', {
          repoPath: activeRepo,
          worktreePath: path,
          entries: files,
          exclude: settings.excludeFromGit,
        });
      } catch (err: any) {
        results = [{ name: 'files', status: 'skipped', message: err?.toString() ?? 'Failed to add files' }];
      }
    }
    // Refresh worktree list and select the branch we just grafted
    await loadWorktrees(activeRepo, false, branch);
    return results;
  };

  const handleSelectWt = (wt: WorktreeInfo, side: 'left' | 'right') => {
    setSelectedWt(wt);
    // Dynamic opens the popover on the opposite side of the screen from the
    // clicked node so it never covers the node (or its neighbors) that was
    // just selected; otherwise it's pinned to the side chosen in settings.
    if (settings.detailsSide === 'dynamic') {
      setPopupSide(side === 'right' ? 'left' : 'right');
    } else {
      setPopupSide(settings.detailsSide);
    }
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
        onOpenSettings={() => {
          refreshEditors();
          setShowSettings(true);
        }}
        homeDir={homeDir}
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
                  {toDisplayPath(activeRepo, homeDir)}
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
              homeDir={homeDir}
              treeLabel={settings.treeLabel}
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
                repoPath={activeRepo}
                side={popupSide}
                homeDir={homeDir}
                onClose={() => setSelectedWt(null)}
                editorLabel={editor?.label ?? null}
                onOpenInEditor={handleOpenInEditor}
                onAddFiles={hasUsableFiles(repoFiles) ? () => setFilesTarget(selectedWt) : undefined}
                onDeleteWorktree={handleDeleteWorktree}
                onRefresh={() => loadWorktrees(activeRepo, true)}
              />
            )}

            {filesTarget && (
              <WorktreeFilesModal
                repoPath={activeRepo}
                worktreePath={filesTarget.path}
                files={repoFiles}
                linkModes={linkModes}
                exclude={settings.excludeFromGit}
                onApplied={() => loadWorktrees(activeRepo, true)}
                onClose={() => setFilesTarget(null)}
              />
            )}

            {/* Graft Modal Dialog */}
            {showGraftModal && (
              <GraftModal
                repoPath={activeRepo}
                homeDir={homeDir}
                worktreeDir={settings.worktreeDir}
                defaultBranch={settings.repoDefaultBranch[activeRepo]}
                files={repoFiles}
                linkModes={linkModes}
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

      {showSettings && (
        <SettingsModal
          settings={settings}
          activeTheme={activeTheme}
          repos={repos}
          activeRepo={activeRepo}
          homeDir={homeDir}
          editors={editors}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
