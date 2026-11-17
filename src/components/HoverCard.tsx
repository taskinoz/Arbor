import React from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { WorktreeInfo } from '../types';
import { timeAgo } from '../utils/time';
import { PrBadges } from './PrBadges';

const STATUS: Record<string, string> = {
  clean: 'Clean',
  dirty: 'Uncommitted changes',
  'no-remote': 'Not on remote',
  merged: 'Merged, remote not deleted',
  'remote-gone': 'Remote branch deleted',
};

interface Props {
  wt: WorktreeInfo;
  statusClass: string;
  // Position inside the canvas, and whether to open leftwards of it.
  x: number;
  y: number;
  flip: boolean;
}

// At-a-glance details for a hovered node, so the tree itself stays uncluttered.
export const HoverCard: React.FC<Props> = ({ wt, statusClass, x, y, flip }) => {
  const folder = wt.path.split('/').pop() || wt.path;
  const commit = wt.last_commit;
  return (
    <div
      className="hover-card"
      style={{ left: x, top: y, transform: flip ? 'translate(calc(-100% - 16px), -50%)' : 'translate(16px, -50%)' }}
    >
      <div className="hover-card-title">{wt.branch ?? 'Detached HEAD'}</div>
      <div className="hover-card-sub">
        {folder}
        {wt.is_main && ' (root)'}
      </div>

      <div className={`hover-card-status ${statusClass}`}>
        <span className="hover-card-dot" />
        {statusClass !== 'clean' && statusClass !== 'dirty' && !wt.is_clean
          ? `${STATUS[statusClass]} · uncommitted changes`
          : STATUS[statusClass]}
      </div>

      {commit && (
        <div className="hover-card-commit">
          <span className="hover-card-subject">{commit.subject}</span>
          <span className="hover-card-meta">
            {commit.author} · {timeAgo(commit.time_ms)}
          </span>
        </div>
      )}

      {wt.upstream_remote && (wt.ahead > 0 || wt.behind > 0) && (
        <div className="hover-card-row">
          {wt.behind > 0 && (
            <span className="sync-pill behind">
              <ArrowDown size={11} /> {wt.behind}
            </span>
          )}
          {wt.ahead > 0 && (
            <span className="sync-pill ahead">
              <ArrowUp size={11} /> {wt.ahead}
            </span>
          )}
          <span className="hover-card-meta">as of last fetch</span>
        </div>
      )}

      {wt.pr && (
        <div className="hover-card-row">
          <PrBadges pr={wt.pr} />
        </div>
      )}

      {wt.created_ms && !wt.is_main && <div className="hover-card-meta">Created {timeAgo(wt.created_ms)}</div>}
    </div>
  );
};
