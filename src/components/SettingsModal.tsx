import React from 'react';
import { X, Check } from 'lucide-react';
import { THEMES, ThemeName } from '../theme';
import { Settings } from '../settings';

interface SettingsModalProps {
  settings: Settings;
  activeTheme: ThemeName;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ settings, activeTheme, onChange, onClose }) => {
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
      </div>
    </div>
  );
};
