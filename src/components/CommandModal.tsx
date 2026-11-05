import React, { useEffect, useRef, useState } from 'react';
import { X, Play, Square, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { toDisplayPath } from '../utils/path';

interface OutputEvent {
  runId: string;
  stderr: boolean;
  text: string;
}

interface ExitEvent {
  runId: string;
  code: number | null;
  error: string | null;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'exited'; code: number }
  | { kind: 'stopped' }
  | { kind: 'error'; message: string };

interface Props {
  repoPath: string;
  worktreePath: string;
  homeDir: string | null;
  // Shown in the header, usually the branch name.
  label: string;
  initialCommand: string;
  // Start initialCommand as soon as the dialog opens.
  autoRun: boolean;
  history: string[];
  onRan: (command: string) => void;
  onClose: () => void;
}

// Keep the log bounded so a chatty command can't grow it without limit.
const MAX_OUTPUT = 200_000;

// Most tools emit no colour when piped, but some force it.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (text: string) => text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export const CommandModal: React.FC<Props> = ({
  repoPath,
  worktreePath,
  homeDir,
  label,
  initialCommand,
  autoRun,
  history,
  onRan,
  onClose,
}) => {
  const [command, setCommand] = useState(initialCommand);
  const [output, setOutput] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const runIdRef = useRef('');
  const runningRef = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  const run = async (raw: string) => {
    const cmd = raw.trim();
    if (!cmd || runningRef.current) return;
    runIdRef.current = crypto.randomUUID();
    runningRef.current = true;
    setStatus({ kind: 'running' });
    setOutput(`$ ${cmd}\n`);
    onRan(cmd);
    try {
      await invoke('run_command', { repoPath, worktreePath, command: cmd, runId: runIdRef.current });
    } catch (err: any) {
      runningRef.current = false;
      setStatus({ kind: 'error', message: err?.toString() || 'Failed to run command' });
    }
  };

  const stop = () => invoke('stop_command', { runId: runIdRef.current }).catch(() => {});

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    (async () => {
      const onOutput = await listen<OutputEvent>('command-output', (e) => {
        if (e.payload.runId !== runIdRef.current) return;
        setOutput((prev) => {
          const next = prev + clean(e.payload.text);
          return next.length > MAX_OUTPUT ? `[earlier output trimmed]\n${next.slice(-MAX_OUTPUT)}` : next;
        });
      });
      const onExit = await listen<ExitEvent>('command-exit', (e) => {
        if (e.payload.runId !== runIdRef.current) return;
        runningRef.current = false;
        const { code, error } = e.payload;
        if (error) setStatus({ kind: 'error', message: error });
        else if (code === null) setStatus({ kind: 'stopped' });
        else setStatus({ kind: 'exited', code });
      });
      unlisteners.push(onOutput, onExit);
      if (cancelled) unlisteners.forEach((u) => u());
      // Listeners are in place, so no early output can be missed.
      else if (autoRun) run(initialCommand);
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
      // Closing the dialog ends whatever it started.
      if (runningRef.current) invoke('stop_command', { runId: runIdRef.current }).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the output unless the user has scrolled up to read it.
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [output]);

  const running = status.kind === 'running';

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
            run(command);
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
              autoFocus={!autoRun}
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
              <button type="button" className="btn-action danger" style={{ width: 'auto', padding: '10px 18px' }} onClick={stop}>
                <Square size={14} />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="submit"
                className="btn-add"
                style={{ width: 'auto', padding: '10px 18px' }}
                disabled={!command.trim()}
              >
                <Play size={14} />
                <span>Run</span>
              </button>
            )}
          </div>
          <span className="form-help">
            Runs in <span className="mono">{toDisplayPath(worktreePath, homeDir)}</span> with your login shell. Closing
            this window stops the command.
          </span>
        </form>

        {status.kind !== 'idle' && (
          <>
            <pre className="command-output mono" ref={logRef}>{output}</pre>
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
