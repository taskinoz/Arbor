import { THEMES, ThemeName } from './theme';

export interface Settings {
  theme: ThemeName;
  autoTheme: boolean;
  // Which name is the bold label on tree nodes; the other goes underneath.
  treeLabel: 'worktree' | 'branch';
  // Which side the details card opens on; 'dynamic' picks the side away
  // from the clicked node.
  detailsSide: 'left' | 'right' | 'dynamic';
}

const DEFAULTS: Settings = {
  theme: 'forest',
  autoTheme: false,
  treeLabel: 'worktree',
  detailsSide: 'dynamic',
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
