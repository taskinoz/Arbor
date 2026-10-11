import React from 'react';
import { Plus, Trash2, FolderOpen } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { FileEntry } from '../types';

interface Props {
  title: string;
  hint: string;
  namePlaceholder: string;
  targetPlaceholder: string;
  entries: FileEntry[];
  onChange: (entries: FileEntry[]) => void;
}

const noAutoText = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

export const FileListEditor: React.FC<Props> = ({
  title,
  hint,
  namePlaceholder,
  targetPlaceholder,
  entries,
  onChange,
}) => {
  const update = (id: string, patch: Partial<FileEntry>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const browse = async (entry: FileEntry) => {
    try {
      const picked = await open({ multiple: false, directory: false, title: `Select ${title.toLowerCase()} source` });
      if (typeof picked === 'string') {
        // Suggest the filename as the target if none was typed yet.
        const base = picked.split('/').pop() ?? '';
        update(entry.id, { source: picked, target: entry.target || base });
      }
    } catch (err) {
      console.error('Failed to pick file:', err);
    }
  };

  return (
    <div className="form-group">
      <span className="form-label">{title}</span>
      {entries.map((e) => (
        <div className="file-entry" key={e.id}>
          <div className="file-entry-row">
            <input
              type="text"
              className="form-input"
              placeholder={namePlaceholder}
              value={e.name}
              onChange={(ev) => update(e.id, { name: ev.target.value })}
              {...noAutoText}
            />
            <button
              type="button"
              className="panel-close"
              onClick={() => onChange(entries.filter((x) => x.id !== e.id))}
              aria-label={`Remove ${e.name || 'file'}`}
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="file-entry-row">
            <input
              type="text"
              className="form-input mono"
              placeholder="Source file (e.g. ~/Obsidian/Agents/Angular.md)"
              value={e.source}
              onChange={(ev) => update(e.id, { source: ev.target.value })}
              {...noAutoText}
            />
            <button type="button" className="panel-close" onClick={() => browse(e)} aria-label="Browse for source file">
              <FolderOpen size={16} />
            </button>
          </div>
          <input
            type="text"
            className="form-input mono"
            style={{ padding: '9px 10px', fontSize: '0.85rem' }}
            placeholder={targetPlaceholder}
            value={e.target}
            onChange={(ev) => update(e.id, { target: ev.target.value })}
            {...noAutoText}
          />
          <label className="form-checkbox-label">
            <input
              type="checkbox"
              className="form-checkbox"
              checked={e.byDefault}
              onChange={(ev) => update(e.id, { byDefault: ev.target.checked })}
            />
            Add to new worktrees by default
          </label>
        </div>
      ))}
      <button
        type="button"
        className="btn-action secondary"
        onClick={() =>
          onChange([...entries, { id: crypto.randomUUID(), name: '', source: '', target: '', byDefault: true }])
        }
      >
        <Plus size={14} />
        <span>Add {title.toLowerCase().replace(/ files?$/, '')} file</span>
      </button>
      <span className="settings-hint">{hint}</span>
    </div>
  );
};
