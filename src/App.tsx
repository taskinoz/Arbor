import { useState, useEffect, useMemo, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { TreeCanvas } from './components/TreeCanvas';
import { DetailsPanel } from './components/DetailsPanel';
import { GraftModal } from './components/GraftModal';
import { ApplyEntry, Editor, FileResult, RemoteInfo, WorktreeInfo } from './types';
import { applyRemoteInfo } from './status';
import { useRuns } from './runs';
import { RunsMenu } from './components/RunsMenu';
import { SyncAllMenu } from './components/SyncAllMenu';
import { invoke } from '@tauri-apps/api/core';
import { GitFork, RefreshCw, Plus, Sparkles, Loader2 } from 'lucide-react';
import { toDisplayPath, resolveWorktreeBase } from './utils/path';
import { ThemeName, applyTheme, currentSeason } from './theme';
import { Settings, loadSettings, saveSettings } from './settings';
import { SettingsModal } from './components/SettingsModal';
import { WorktreeFilesModal } from './components/WorktreeFilesModal';
import { CommandModal } from './components/CommandModal';
import { BulkRemoveModal } from './components/BulkRemoveModal';
import { EMPTY_FILES, hasUsableFiles } from './components/FilePicker';
import './App.css';

function App() {
  const [repos, setRepos] = useState<string[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  // Local-only data from get_worktrees, refined by the background remote pass.
  const [localWorktrees, setLocalWorktrees] = useState<WorktreeInfo[]>([]);
  const [remoteInfo, setRemoteInfo] = useState<{ repo: string; info: RemoteInfo } | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const remoteRequest = useRef(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // The repo's default branch on GitHub, looked up once per repo.
  const [githubDefault, setGithubDefault] = useState<{ repo: string; name: string | null } | null>(null);
  const [popupSide, setPopupSide] = useState<'left' | 'right'>('right');
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [editors, setEditors] = useState<Editor[]>([]);
  const [filesTarget, setFilesTarget] = useState<WorktreeInfo | null>(null);
  // A command to run in a worktree: the dialog is open (runTarget), or waiting
  // for the Graft dialog to close first (pendingRun).
  // runId shows an existing run; autoRun starts `command` when it opens.
  type RunRequest = { path: string; label: string; command: string; autoRun?: boolean; runId?: string };
  const runs = useRuns();
  const [terminals, setTerminals] = useState<Editor[]>([]);
  const [runTarget, setRunTarget] = useState<RunRequest | null>(null);
  const [bulkRemove, setBulkRemove] = useState<WorktreeInfo[] | null>(null);
  const [pendingRun, setPendingRun] = useState<RunRequest | null>(null);

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
      setTerminals(await invoke<Editor[]>('detect_terminals'));
    } catch (err) {
      console.error('Failed to detect editors:', err);
    }
  };

  const editor = editors.find((e) => e.id === settings.openWith) ?? editors[0] ?? null;
  const terminal = terminals.find((t) => t.id === settings.openTerminalWith) ?? terminals[0] ?? null;
  const repoFiles = (activeRepo && settings.repoFiles[activeRepo]) || EMPTY_FILES;
  const linkModes = { agent: settings.agentLinkMode, env: settings.envLinkMode };

  const worktrees = useMemo(
    () => applyRemoteInfo(localWorktrees, remoteInfo && remoteInfo.repo === activeRepo ? remoteInfo.info : null),
    [localWorktrees, remoteInfo, activeRepo]
  );
  // Looked up by path so the details card follows refreshed data.
  const selectedWt = worktrees.find((w) => w.path === selectedPath) ?? null;
  const setSelectedWt = (wt: WorktreeInfo | null) => setSelectedPath(wt?.path ?? null);

  // The slow part (ls-remote + gh): runs after the tree is on screen, and is
  // dropped if a newer refresh or a repo switch has started since.
  const loadRemoteInfo = async (repoPath: string) => {
    const request = ++remoteRequest.current;
    setRemoteLoading(true);
    try {
      const info = await invoke<RemoteInfo>('get_remote_info', { repoPath });
      if (request === remoteRequest.current) setRemoteInfo({ repo: repoPath, info });
    } catch (err) {
      console.error('Failed to load remote info:', err);
    } finally {
      if (request === remoteRequest.current) setRemoteLoading(false);
    }
  };

  // Fetch worktrees whenever the active repository changes
  useEffect(() => {
    if (!activeRepo) {
      setLocalWorktrees([]);
      setSelectedWt(null);
      return;
    }
    // Clear the tree immediately rather than leaving the previous repo's
    // (now stale) tree dimmed underneath a spinner - the canvas goes blank
    // with a loading throbber, then the new tree grows in once it arrives.
    setLocalWorktrees([]);
    setRemoteInfo(null);
    setSelectedWt(null);
    loadWorktrees(activeRepo);
    const repo = activeRepo;
    invoke<string | null>('get_default_branch', { repoPath: repo })
      .then((name) => setGithubDefault({ repo, name }))
      .catch(() => setGithubDefault({ repo, name: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRepo]);

  const loadWorktrees = async (repoPath: string, preserveSelection = false, selectBranch?: string) => {
    setIsLoadingWorktrees(true);
    const previousSelectedPath = preserveSelection ? selectedWt?.path : null;
    if (!preserveSelection) setSelectedWt(null);
    try {
      const list: WorktreeInfo[] = await invoke('get_worktrees', { repoPath });
      setLocalWorktrees(list);
      loadRemoteInfo(repoPath);
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
      setLocalWorktrees([]);
    } finally {
      setIsLoadingWorktrees(false);
    }
  };

  // Open the command dialog once the Graft dialog (and any file report) is gone.
  useEffect(() => {
    if (pendingRun && !showGraftModal && activeRepo) {
      const request = pendingRun;
      if (request.autoRun) {
        runs.start(activeRepo, request.path, request.label, request.command).then((runId) => setRunTarget({ ...request, runId }));
      } else {
        setRunTarget(request);
      }
      setPendingRun(null);
    }
  }, [pendingRun, showGraftModal]);

  const rememberCommand = (command: string) => {
    if (!activeRepo) return;
    updateSettings({
      repoCommandHistory: {
        ...settings.repoCommandHistory,
        [activeRepo]: [command, ...(settings.repoCommandHistory[activeRepo] ?? []).filter((c) => c !== command)].slice(0, 10),
      },
    });
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

  const handleOpenInTerminal = async (path: string) => {
    if (!terminal) return;
    try {
      await invoke('open_in_terminal', { terminalId: terminal.id, path });
    } catch (err: any) {
      alert(err?.toString() || `Failed to open ${terminal.label}`);
    }
  };

  const wtLabel = (wt: WorktreeInfo) => wt.branch ?? wt.path.split('/').pop() ?? wt.path;

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
    files: ApplyEntry[],
    command: string
  ): Promise<FileResult[]> => {
    if (!activeRepo) return [];
    await invoke('create_worktree', {
      repoPath: activeRepo,
      path,
      branch,
      newBranch,
      baseBranch,
      excludeDir: graftExcludeDir(),
    });
    return finishGraft(path, branch, files, command);
  };

  // When worktrees live inside the repo, hide that folder from git status.
  const graftExcludeDir = () => {
    if (!activeRepo) return undefined;
    const base = resolveWorktreeBase(activeRepo, settings.worktreeDir, homeDir);
    return settings.excludeFromGit && base.startsWith(`${activeRepo}/`) ? base.slice(activeRepo.length + 1) : undefined;
  };

  const handleGraftPr = async (path: string, pr: string, files: ApplyEntry[], command: string) => {
    if (!activeRepo) return [];
    const branch = await invoke<string>('create_pr_worktree', { repoPath: activeRepo, path, pr, excludeDir: graftExcludeDir() });
    return finishGraft(path, branch, files, command);
  };

  // After a worktree is created: add files, select it, run the setup command.
  const finishGraft = async (path: string, branch: string, files: ApplyEntry[], command: string): Promise<FileResult[]> => {
    if (!activeRepo) return [];
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
    if (command) setPendingRun({ path, label: branch, command, autoRun: true });
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
                <SyncAllMenu repoPath={activeRepo} homeDir={homeDir} onDone={() => loadWorktrees(activeRepo, true)} />
                <RunsMenu
                  runs={Object.values(runs.runs)}
                  onView={(run) => setRunTarget({ path: run.worktreePath, label: run.label, command: run.command, runId: run.id })}
                  onStop={runs.stop}
                />
                {remoteLoading && !isLoadingWorktrees && (
                  <span className="remote-checking" title="Checking which branches still exist on the remote, and their pull requests">
                    <Loader2 size={13} className="loading-spinner" /> Checking remote…
                  </span>
                )}
                <button
                  type="button"
                  className="btn-graft"
                  style={{ padding: '10px 20px', border: '1px solid rgba(255,255,255,0.08)' }}
                  onClick={() => loadWorktrees(activeRepo, true)}
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
              onRemoveShown={setBulkRemove}
              staleDays={settings.staleDays}
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
                baseBranch={
                  settings.repoDefaultBranch[activeRepo] ||
                  (githubDefault?.repo === activeRepo ? githubDefault.name : null)
                }
                side={popupSide}
                homeDir={homeDir}
                onClose={() => setSelectedWt(null)}
                editorLabel={editor?.label ?? null}
                onOpenInEditor={handleOpenInEditor}
                onAddFiles={hasUsableFiles(repoFiles) ? () => setFilesTarget(selectedWt) : undefined}
                terminalLabel={terminal?.label ?? null}
                onOpenInTerminal={handleOpenInTerminal}
                onRunCommand={() => setRunTarget({ path: selectedWt.path, label: wtLabel(selectedWt), command: '' })}
                savedCommands={settings.repoCommands[activeRepo] ?? []}
                runs={Object.values(runs.runs).filter((r) => r.worktreePath === selectedWt.path)}
                onRunSaved={async (command) => {
                  const runId = await runs.start(activeRepo, selectedWt.path, wtLabel(selectedWt), command);
                  setRunTarget({ path: selectedWt.path, label: wtLabel(selectedWt), command, runId });
                }}
                onViewRun={(run) => setRunTarget({ path: run.worktreePath, label: run.label, command: run.command, runId: run.id })}
                onStopRun={runs.stop}
                onDismissRun={runs.dismiss}
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

            {bulkRemove && (
              <BulkRemoveModal
                repoPath={activeRepo}
                worktrees={bulkRemove}
                homeDir={homeDir}
                onDone={() => loadWorktrees(activeRepo, true)}
                onClose={() => setBulkRemove(null)}
              />
            )}

            {runTarget && (
              <CommandModal
                key={runTarget.runId ?? runTarget.path}
                runs={runs}
                runId={runTarget.runId ?? null}
                repoPath={activeRepo}
                worktreePath={runTarget.path}
                homeDir={homeDir}
                label={runTarget.label}
                initialCommand={runTarget.command}
                history={settings.repoCommandHistory[activeRepo] ?? []}
                onRan={rememberCommand}
                onClose={() => setRunTarget(null)}
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
                setupCommand={settings.repoSetupCommand[activeRepo] ?? ''}
                linkModes={linkModes}
                onClose={() => setShowGraftModal(false)}
                onSubmit={handleGraftSubmit}
                onSubmitPr={handleGraftPr}
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
          terminals={terminals}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
