import React from 'react';
import { PrInfo } from '../types';

const STATE: Record<string, [string, string]> = {
  OPEN: ['Open', 'open'],
  MERGED: ['Merged', 'merged'],
  CLOSED: ['Closed', 'closed'],
};

const REVIEW: Record<string, [string, string]> = {
  APPROVED: ['Approved', 'good'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
  REVIEW_REQUIRED: ['Review required', 'wait'],
};

const CHECKS: Record<string, [string, string]> = {
  passing: ['Checks passing', 'good'],
  failing: ['Checks failing', 'bad'],
  pending: ['Checks running', 'wait'],
};

// "#123 Open · Approved · Checks passing" as small chips. Review and checks
// only matter while the PR is open.
export const PrBadges: React.FC<{ pr: PrInfo }> = ({ pr }) => {
  const [stateLabel, stateClass] = pr.isDraft && pr.state === 'OPEN' ? ['Draft', 'draft'] : STATE[pr.state] ?? [pr.state, 'closed'];
  const open = pr.state === 'OPEN';
  const review = open && pr.review ? REVIEW[pr.review] : undefined;
  const checks = open && pr.checks ? CHECKS[pr.checks] : undefined;
  return (
    <span className="pr-badges">
      <span className={`pr-chip ${stateClass}`}>
        #{pr.number} {stateLabel}
      </span>
      {review && <span className={`pr-chip ${review[1]}`}>{review[0]}</span>}
      {checks && <span className={`pr-chip ${checks[1]}`}>{checks[0]}</span>}
    </span>
  );
};
