import { THEMES, ThemeName } from './theme';
import { DEFAULT_WORKTREE_DIR } from './utils/path';
import { LinkMode, RepoFiles } from './types';

export interface Settings {
  theme: ThemeName;
  autoTheme: boolean;
  // Which name is the bold label on tree nodes; the other goes underneath.
  treeLabel: 'worktree' | 'branch';
  // Which side the details card opens on; 'dynamic' picks the side away
  // from the clicked node.
  detailsSide: 'left' | 'right' | 'dynamic';
  // Where new worktrees are created: relative to the repo root, or absolute.
  worktreeDir: string;
  // Per-repo base branch for new branches, keyed by repo path. A repo with no
  // entry uses its default branch on GitHub.
  repoDefaultBranch: Record<string, string>;
  // Agent and env files are linked/copied independently, e.g. symlink the
  // agent notes but copy .env so a worktree can point at a different database.
  agentLinkMode: LinkMode;
  envLinkMode: LinkMode;
  // Files to put in new worktrees, per repo path.
  repoFiles: Record<string, RepoFiles>;
  // Hide linked files and the worktree folder from `git status` via the
  // repo's local .git/info/exclude.
  excludeFromGit: boolean;
  // Editor id for "Open in ..."; '' means the first one detected.
  openWith: string;
}

const DEFAULTS: Settings = {
  theme: 'forest',
  autoTheme: false,
  treeLabel: 'worktree',
  detailsSide: 'dynamic',
  worktreeDir: DEFAULT_WORKTREE_DIR,
  repoDefaultBranch: {},
  agentLinkMode: 'symlink',
  envLinkMode: 'copy',
  repoFiles: {},
  excludeFromGit: true,
  openWith: '',
};

const KEY = 'arbor.settings';

export const loadSettings = (): Settings => {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    return saved.theme in THEMES ? saved : { ...saved, theme: DEFAULTS.theme };
  } catch {
    return DEFAULTS;
  }
};

export const saveSettings = (settings: Settings) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable - settings just won't persist this session.
  }
};
