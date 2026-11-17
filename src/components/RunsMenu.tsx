import React, { useEffect, useRef, useState } from 'react';
import { Activity, Square, ChevronDown } from 'lucide-react';
import { Run } from '../runs';

interface Props {
  runs: Run[];
  onView: (run: Run) => void;
  onStop: (id: string) => void;
}

export const runStatusText = (run: Run) => {
  const s = run.status;
  if (s.kind === 'running') return 'Running';
  if (s.kind === 'exited') return s.code === 0 ? 'Finished' : `Exited ${s.code}`;
  if (s.kind === 'stopped') return 'Stopped';
  return 'Failed';
};

// Top-bar list of commands started from Arbor, across all worktrees. Hidden
// until something has been run.
export const RunsMenu: React.FC<Props> = ({ runs, onView, onStop }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const running = runs.filter((r) => r.status.kind === 'running').length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (runs.length === 0) return null;
  const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);

  return (
    <div className="runs-menu" ref={ref}>
      <button type="button" className={`runs-menu-button ${running ? 'active' : ''}`} onClick={() => setOpen(!open)}>
        <Activity size={14} />
        <span>{running ? `${running} running` : 'Recent runs'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="runs-menu-list">
          {sorted.map((run) => (
            <div key={run.id} className="runs-menu-row">
              <button
                type="button"
                className="runs-menu-item"
                onClick={() => {
                  setOpen(false);
                  onView(run);
                }}
              >
                <span className="mono runs-menu-command">{run.command}</span>
                <span className="runs-menu-meta">
                  {run.label} · <span className={`run-state ${run.status.kind}`}>{runStatusText(run)}</span>
                </span>
              </button>
              {run.status.kind === 'running' && (
                <button type="button" className="panel-close" title="Stop" onClick={() => onStop(run.id)}>
                  <Square size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
