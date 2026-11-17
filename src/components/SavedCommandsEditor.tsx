import React from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { SavedCommand } from '../settings';

interface Props {
  commands: SavedCommand[];
  onChange: (commands: SavedCommand[]) => void;
}

// Per-repo one-click commands (npm test, npm run dev, ...) for the details card.
export const SavedCommandsEditor: React.FC<Props> = ({ commands, onChange }) => {
  const update = (id: string, patch: Partial<SavedCommand>) =>
    onChange(commands.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  return (
    <div className="form-group">
      <span className="form-label">Saved commands</span>
      <span className="settings-hint">Shown as one-click buttons on each worktree's details card.</span>
      {commands.map((c) => (
        <div key={c.id} className="file-entry-row">
          <input
            type="text"
            className="form-input"
            style={{ flex: '0 0 130px' }}
            placeholder="Name (e.g. Dev)"
            value={c.name}
            onChange={(e) => update(c.id, { name: e.target.value })}
            aria-label="Command name"
          />
          <input
            type="text"
            className="form-input mono"
            placeholder="npm run dev"
            value={c.command}
            onChange={(e) => update(c.id, { command: e.target.value })}
            aria-label="Command"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="button"
            className="panel-close"
            title="Remove"
            onClick={() => onChange(commands.filter((x) => x.id !== c.id))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-action secondary"
        style={{ width: 'auto', alignSelf: 'flex-start', padding: '8px 14px' }}
        onClick={() => onChange([...commands, { id: crypto.randomUUID(), name: '', command: '' }])}
      >
        <Plus size={14} />
        <span>Add command</span>
      </button>
    </div>
  );
};
