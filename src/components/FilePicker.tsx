import React, { useState } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import { ApplyEntry, FileEntry, FileResult, LinkMode, RepoFiles } from '../types';

export const EMPTY_FILES: RepoFiles = { agents: [], envs: [] };

// Entries still being typed in settings have no source/target yet.
export const isUsable = (e: FileEntry) => e.source.trim() !== '' && e.target.trim() !== '';
export const hasUsableFiles = (f: RepoFiles) => [...f.agents, ...f.envs].some(isUsable);

export function useFileSelection(files: RepoFiles, defaults: { agent: LinkMode; env: LinkMode }) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set([...files.agents, ...files.envs].filter((e) => e.byDefault && isUsable(e)).map((e) => e.id))
  );
  const [modes, setModes] = useState(defaults);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const build = (): ApplyEntry[] => {
    const pick = (list: FileEntry[], mode: LinkMode) =>
      list
        .filter((e) => selected.has(e.id) && isUsable(e))
        .map((e) => ({ name: e.name.trim() || e.target, source: e.source, target: e.target, mode }));
    return [...pick(files.agents, modes.agent), ...pick(files.envs, modes.env)];
  };

  return { selected, toggle, modes, setModes, build };
}

type Selection = ReturnType<typeof useFileSelection>;

const GROUPS = [
  { kind: 'agent', title: 'Agent files', list: 'agents' },
  { kind: 'env', title: 'Env files', list: 'envs' },
] as const;

export const FilePicker: React.FC<{ files: RepoFiles; selection: Selection; disabled?: boolean }> = ({
  files,
  selection,
  disabled,
}) => (
  <>
    {GROUPS.map(({ kind, title, list }) => {
      const entries = files[list].filter(isUsable);
      if (entries.length === 0) return null;
      const mode = selection.modes[kind];
      return (
        <div className="form-group" key={kind}>
          <div className="file-picker-header">
            <span className="form-label">{title}</span>
            <div className="segmented segmented-small">
              {(['symlink', 'copy'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={mode === m ? 'active' : ''}
                  disabled={disabled}
                  onClick={() => selection.setModes((prev) => ({ ...prev, [kind]: m }))}
                >
                  {m === 'symlink' ? 'Symlink' : 'Copy'}
                </button>
              ))}
            </div>
          </div>
          {entries.map((e) => (
            <label className="form-checkbox-label" key={e.id}>
              <input
                type="checkbox"
                className="form-checkbox"
                checked={selection.selected.has(e.id)}
                onChange={() => selection.toggle(e.id)}
                disabled={disabled}
              />
              <span>
                {e.name.trim() || e.target} <span className="mono file-target">{e.target}</span>
              </span>
            </label>
          ))}
        </div>
      );
    })}
  </>
);

export const FileResults: React.FC<{ results: FileResult[] }> = ({ results }) => (
  <div className="file-results">
    {results.map((r, i) => (
      <div key={i} className={`file-result ${r.status}`}>
        {r.status === 'skipped' ? <AlertTriangle size={14} /> : <Check size={14} />}
        <span>
          <b>{r.name}</b> {r.status}
          {r.message && <span className="file-result-message"> - {r.message}</span>}
        </span>
      </div>
    ))}
  </div>
);
