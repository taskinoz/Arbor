import React, { useEffect, useState } from 'react';
import { X, Check } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_WORKTREE_DIR, lastSegment, resolveWorktreeBase, toDisplayPath } from '../utils/path';
import { THEMES, ThemeName } from '../theme';
import { Settings } from '../settings';
import { Editor, LinkMode, RepoFiles } from '../types';
import { EMPTY_FILES } from './FilePicker';
import { FileListEditor } from './FileListEditor';

interface SettingsModalProps {
  settings: Settings;
  activeTheme: ThemeName;
  repos: string[];
  activeRepo: string | null;
  homeDir: string | null;
  editors: Editor[];
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  activeTheme,
  repos,
  activeRepo,
  homeDir,
  editors,
  onChange,
  onClose,
}) => {
  // Which repo the per-repo settings below are editing.
  const [repo, setRepo] = useState(activeRepo ?? repos[0] ?? '');
  const [branches, setBranches] = useState<string[]>([]);
  const [githubDefault, setGithubDefault] = useState<string | null>(null);

  useEffect(() => {
    if (!repo) return;
    let cancelled = false;
    setBranches([]);
    setGithubDefault(null);
    invoke<string[]>('get_git_branches', { repoPath: repo })
      .then((list) => {
        const names = list.map((b) => b.replace(/^origin\//, '')).filter((b) => b !== 'origin' && b !== 'HEAD');
        if (!cancelled) setBranches(Array.from(new Set(names)));
      })
      .catch(() => {});
    invoke<string | null>('get_default_branch', { repoPath: repo })
      .then((name) => !cancelled && setGithubDefault(name))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const override = settings.repoDefaultBranch[repo] ?? '';
  const branchOptions = override && !branches.includes(override) ? [override, ...branches] : branches;
  const setOverride = (value: string) => {
    const next = { ...settings.repoDefaultBranch };
    if (value) next[repo] = value;
    else delete next[repo];
    onChange({ repoDefaultBranch: next });
  };

  const repoFiles = settings.repoFiles[repo] ?? EMPTY_FILES;
  const setRepoFiles = (patch: Partial<RepoFiles>) =>
    onChange({ repoFiles: { ...settings.repoFiles, [repo]: { ...repoFiles, ...patch } } });

  const linkModeRow = (label: string, value: LinkMode, key: 'agentLinkMode' | 'envLinkMode') => (
    <div className="form-group">
      <span className="form-label">{label}</span>
      <div className="segmented">
        {(['symlink', 'copy'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={value === mode ? 'active' : ''}
            onClick={() => onChange({ [key]: mode })}
          >
            {mode === 'symlink' ? 'Symlink' : 'Copy'}
          </button>
        ))}
      </div>
    </div>
  );

  const previewBase = repo
    ? toDisplayPath(resolveWorktreeBase(repo, settings.worktreeDir, homeDir), homeDir)
    : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Settings</h2>
          <button type="button" className="panel-close" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>

        <section className="settings-section">
          <h3 className="section-title">Theme</h3>
          <div className="theme-swatches">
            {(Object.keys(THEMES) as ThemeName[]).map((name) => {
              const { label, accent, icon } = THEMES[name];
              const selected = name === activeTheme;
              return (
                <button
                  key={name}
                  type="button"
                  className={`theme-swatch ${selected ? 'selected' : ''}`}
                  style={{ background: `radial-gradient(circle at 50% 40%, ${icon[0]} 0%, ${icon[1]} 100%)`, borderColor: selected ? accent : undefined }}
                  onClick={() => onChange({ theme: name, autoTheme: false })}
                  aria-pressed={selected}
                  title={label}
                >
                  <span className="theme-swatch-dot" style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}>
                    {selected && <Check size={12} color="#000" />}
                  </span>
                  <span className="theme-swatch-label">{label}</span>
                </button>
              );
            })}
          </div>
          <label className="form-checkbox-label">
            <input
              type="checkbox"
              className="form-checkbox"
              checked={settings.autoTheme}
              onChange={(e) => onChange({ autoTheme: e.target.checked, theme: activeTheme })}
            />
            Change theme with the seasons
          </label>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Tree</h3>
          <div className="form-group">
            <span className="form-label">Main label on each node</span>
            <div className="segmented">
              {(['worktree', 'branch'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={settings.treeLabel === value ? 'active' : ''}
                  onClick={() => onChange({ treeLabel: value })}
                >
                  {value === 'worktree' ? 'Worktree name' : 'Branch name'}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <span className="form-label">Worktree details card</span>
            <div className="segmented">
              {(['left', 'right', 'dynamic'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={settings.detailsSide === value ? 'active' : ''}
                  onClick={() => onChange({ detailsSide: value })}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
            <span className="settings-hint">
              Dynamic switches the card to the opposite side of the selected node so it never covers it.
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Open with</h3>
          {editors.length === 0 ? (
            <span className="settings-hint">
              No supported editor found. VS Code, Cursor, Zed, Sublime Text, Visual Studio and JetBrains IDEs are detected
              from your installed apps and PATH.
            </span>
          ) : (
            <div className="form-group">
              <select
                className="form-select"
                aria-label="Editor"
                value={editors.some((e) => e.id === settings.openWith) ? settings.openWith : editors[0].id}
                onChange={(e) => onChange({ openWith: e.target.value })}
              >
                {editors.map((e) => (
                  <option key={e.id} value={e.id}>{e.label}</option>
                ))}
              </select>
              <span className="settings-hint">Detected from your installed apps and PATH.</span>
            </div>
          )}
        </section>

        <section className="settings-section">
          <h3 className="section-title">Worktrees</h3>
          <div className="form-group">
            <label className="form-label" htmlFor="worktree-dir">Worktree directory</label>
            <input
              id="worktree-dir"
              type="text"
              className="form-input mono"
              placeholder={DEFAULT_WORKTREE_DIR}
              value={settings.worktreeDir}
              onChange={(e) => onChange({ worktreeDir: e.target.value })}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <span className="settings-hint">
              Relative to the repo root; absolute and ~ paths work too.
              {previewBase && (
                <>
                  {' '}New worktrees for <b>{lastSegment(repo)}</b> go in <span className="mono">{previewBase}/</span>
                </>
              )}
            </span>
          </div>
          {linkModeRow('Agent files', settings.agentLinkMode, 'agentLinkMode')}
          {linkModeRow('Env files', settings.envLinkMode, 'envLinkMode')}
          <span className="settings-hint">
            Symlinks follow edits to the original file. Copies are independent, so a worktree's .env can point at a
            different database. You can override both when grafting.
          </span>
          <label className="form-checkbox-label">
            <input
              type="checkbox"
              className="form-checkbox"
              checked={settings.excludeFromGit}
              onChange={(e) => onChange({ excludeFromGit: e.target.checked })}
            />
            Hide the worktree folder and added files from git status
          </label>
          <span className="settings-hint">Writes to the repo's local .git/info/exclude; nothing is committed.</span>
        </section>

        <section className="settings-section">
          <h3 className="section-title">Repository</h3>
          {repos.length === 0 ? (
            <span className="settings-hint">Add a repository to set its default branch.</span>
          ) : (
            <>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-repo">Repository</label>
                <select
                  id="settings-repo"
                  className="form-select"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                >
                  {repos.map((r) => (
                    <option key={r} value={r}>{lastSegment(r)}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="settings-default-branch">Base branch for new branches</label>
                <select
                  id="settings-default-branch"
                  className="form-select"
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                >
                  <option value="">
                    {githubDefault ? `GitHub default (${githubDefault})` : 'GitHub default'}
                  </option>
                  {branchOptions.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                <span className="settings-hint">
                  Pre-selected as the base when grafting a new branch in this repo.
                </span>
              </div>
              <FileListEditor
                title="Agent files"
                hint="Instruction files such as CLAUDE.md. Targets are paths inside the worktree."
                namePlaceholder="Name (e.g. Angular)"
                targetPlaceholder="Target in worktree (e.g. app/.claude/CLAUDE.md)"
                entries={repoFiles.agents}
                onChange={(agents) => setRepoFiles({ agents })}
              />
              <FileListEditor
                title="Env files"
                hint="Untracked files git worktrees don't share, such as .env."
                namePlaceholder="Name (e.g. API test db)"
                targetPlaceholder="Target in worktree (e.g. server/.env)"
                entries={repoFiles.envs}
                onChange={(envs) => setRepoFiles({ envs })}
              />
            </>
          )}
        </section>
      </div>
    </div>
  );
};
