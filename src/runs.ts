import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Commands run in worktrees. They live here, at the app level, rather than in
// the dialog that started them, so a dev server keeps running (and keeps its
// log) after the dialog closes. Arbor stops anything still running on quit.

export type RunStatus =
  | { kind: 'running' }
  | { kind: 'exited'; code: number }
  | { kind: 'stopped' }
  | { kind: 'error'; message: string };

export interface Run {
  id: string;
  worktreePath: string;
  label: string;
  command: string;
  output: string;
  status: RunStatus;
  startedAt: number;
}

// Keep each log bounded so a chatty command can't grow it without limit.
const MAX_OUTPUT = 200_000;

// Most tools emit no colour when piped, but some force it.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (text: string) => text.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export const useRuns = () => {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const runsRef = useRef(runs);
  runsRef.current = runs;

  const update = (id: string, change: (run: Run) => Partial<Run>) =>
    setRuns((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...change(prev[id]) } } : prev));

  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      listen<{ runId: string; text: string }>('command-output', (e) =>
        update(e.payload.runId, (run) => {
          const next = run.output + clean(e.payload.text);
          return { output: next.length > MAX_OUTPUT ? `[earlier output trimmed]\n${next.slice(-MAX_OUTPUT)}` : next };
        })
      ),
      listen<{ runId: string; code: number | null; error: string | null }>('command-exit', (e) => {
        const { code, error } = e.payload;
        update(e.payload.runId, () => ({
          status: error ? { kind: 'error', message: error } : code === null ? { kind: 'stopped' } : { kind: 'exited', code },
        }));
      }),
    ];
    return () => unlisteners.forEach((u) => u.then((f) => f()));
  }, []);

  const start = async (repoPath: string, worktreePath: string, label: string, command: string) => {
    const id = crypto.randomUUID();
    setRuns((prev) => ({
      ...prev,
      [id]: { id, worktreePath, label, command, output: `$ ${command}\n`, status: { kind: 'running' }, startedAt: Date.now() },
    }));
    try {
      await invoke('run_command', { repoPath, worktreePath, command, runId: id });
    } catch (err: any) {
      update(id, () => ({ status: { kind: 'error', message: err?.toString() || 'Failed to run command' } }));
    }
    return id;
  };

  const stop = (id: string) => invoke('stop_command', { runId: id }).catch(() => {});

  // Forget a finished run (its log goes with it).
  const dismiss = (id: string) =>
    setRuns((prev) => {
      if (prev[id]?.status.kind === 'running') return prev;
      const { [id]: _, ...rest } = prev;
      return rest;
    });

  return { runs, start, stop, dismiss };
};

export type Runs = ReturnType<typeof useRuns>;
