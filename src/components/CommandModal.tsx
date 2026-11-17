import React, { useEffect, useRef, useState } from 'react';
import { X, Play, Square, Loader2 } from 'lucide-react';
import { toDisplayPath } from '../utils/path';
import { Runs } from '../runs';

interface Props {
  runs: Runs;
  repoPath: string;
  worktreePath: string;
  homeDir: string | null;
  // Shown in the header, usually the branch name.
  label: string;
  // An existing run to show, or none to start with an empty command box.
  runId: string | null;
  initialCommand: string;
  history: string[];
  onRan: (command: string) => void;
  onClose: () => void;
}

export const CommandModal: React.FC<Props> = ({
  runs,
  repoPath,
  worktreePath,
  homeDir,
  label,
  runId: initialRunId,
  initialCommand,
  history,
  onRan,
  onClose,
}) => {
  const [runId, setRunId] = useState(initialRunId);
  const run = runId ? runs.runs[runId] : undefined;
  const [command, setCommand] = useState(run?.command ?? initialCommand);
  const logRef = useRef<HTMLPreElement>(null);
  const running = run?.status.kind === 'running';

  const start = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    onRan(cmd);
    setRunId(await runs.start(repoPath, worktreePath, label, cmd));
  };

  // Follow the output unless the user has scrolled up to read it.
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [run?.output]);

  const status = run?.status;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content command-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Run Command</h2>
          <button type="button" className="panel-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <form
          className="form-group"
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <label className="form-label" htmlFor="run-command">
            Command to run in <span className="mono">{label}</span>
          </label>
          <div className="file-entry-row">
            <input
              id="run-command"
              type="text"
              className="form-input mono"
              placeholder="npm install"
              list="run-command-history"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              disabled={running}
              autoFocus={!run}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <datalist id="run-command-history">
              {history.map((h) => (
                <option key={h} value={h} />
              ))}
            </datalist>
            {running ? (
              <button
                type="button"
                className="btn-action danger"
                style={{ width: 'auto', padding: '10px 18px' }}
                onClick={() => runs.stop(run!.id)}
              >
                <Square size={14} />
                <span>Stop</span>
              </button>
            ) : (
              <button type="submit" className="btn-add" style={{ width: 'auto', padding: '10px 18px' }} disabled={!command.trim()}>
                <Play size={14} />
                <span>{run ? 'Run again' : 'Run'}</span>
              </button>
            )}
          </div>
          <span className="form-help">
            Runs in <span className="mono">{toDisplayPath(worktreePath, homeDir)}</span> with your login shell. It keeps
            running if you close this window; Arbor stops it when you quit.
          </span>
        </form>

        {run && status && (
          <>
            <pre className="command-output mono" ref={logRef}>{run.output}</pre>
            <div className={`command-status ${status.kind === 'exited' && status.code !== 0 ? 'error' : status.kind}`}>
              {status.kind === 'running' && (
                <>
                  <Loader2 className="loading-spinner" size={14} /> Running...
                </>
              )}
              {status.kind === 'exited' && (status.code === 0 ? 'Finished successfully' : `Exited with code ${status.code}`)}
              {status.kind === 'stopped' && 'Stopped'}
              {status.kind === 'error' && status.message}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
