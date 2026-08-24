import React, { useState } from 'react';
import { WorktreeInfo } from '../types';
import { RefreshCw } from 'lucide-react';

interface TreeCanvasProps {
  worktrees: WorktreeInfo[];
  selectedWt: WorktreeInfo | null;
  onSelectWt: (wt: WorktreeInfo, side: 'left' | 'right') => void;
  isLoading: boolean;
}

export const TreeCanvas: React.FC<TreeCanvasProps> = ({
  worktrees,
  selectedWt,
  onSelectWt,
  isLoading,
}) => {
  const [hoveredWt, setHoveredWt] = useState<string | null>(null);

  // Dimensions of our SVG coordinate space
  const width = 650;
  const height = 500;

  // Separate main worktree and additional worktrees
  const mainWt = worktrees.find((w) => w.is_main) || worktrees[0];
  const additionalWts = worktrees.filter((w) => w !== mainWt);

  // Define position of the main root worktree node (at the base of the trunk)
  const rootX = width / 2;
  const rootY = 410;
  
  // Height of the trunk end
  const trunkEndY = 260;

  // Let's compute branch layout for additional worktrees
  const branches = additionalWts.map((wt, index) => {
    const K = additionalWts.length;
    
    // Distribute angles in radians. 
    // We spread them between -165deg (left-ish) and -15deg (right-ish)
    // -90deg is straight up
    const startAngle = -165;
    const endAngle = -15;
    const angleRange = endAngle - startAngle;
    
    // Spread angles evenly. If there is only 1 branch, point it slightly left (-120deg)
    let angleDeg = -120;
    if (K > 1) {
      angleDeg = startAngle + (index * angleRange) / (K - 1);
    }
    
    const angleRad = (angleDeg * Math.PI) / 180;
    
    // Length varies (3-tier stagger, plus a boost as more branches are added)
    // to keep neighboring nodes/labels from landing on top of each other.
    const spreadBoost = Math.min(K * 3, 40);
    const length = 150 + spreadBoost + (index % 3) * 25 + Math.min(index * 5, 40);
    
    // Forking point on the main trunk. Branches fork between rootY (410) and trunkEndY (260)
    let yFork = rootY - 30;
    if (K > 1) {
      yFork = rootY - 30 - (index * (rootY - 30 - trunkEndY)) / (K - 1);
    } else if (K === 1) {
      yFork = 330;
    }

    // Leaf coordinates
    const leafX = rootX + length * Math.cos(angleRad);
    const leafY = yFork + length * Math.sin(angleRad);

    // Control points for cubic bezier curves
    // Keeps it vertical near trunk, curves gracefully to leaf
    const c1X = rootX + (leafX - rootX) * 0.15;
    const c1Y = yFork - 20;
    const c2X = leafX - (leafX - rootX) * 0.35;
    const c2Y = leafY + 30;

    const pathD = `M ${rootX} ${yFork} C ${c1X} ${c1Y}, ${c2X} ${c2Y}, ${leafX} ${leafY}`;

    return {
      wt,
      leafX,
      leafY,
      pathD,
      angleDeg,
    };
  });

  const getBranchLabel = (wt: WorktreeInfo) => {
    return wt.branch || 'detached';
  };

  const getFolderLabel = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  // Long branch/folder names get cut short in the tree itself (with the full
  // name available as a native tooltip) so labels stay legible and don't
  // sprawl into neighboring nodes.
  const truncateLabel = (text: string, maxLen = 16) => {
    if (text.length <= maxLen) return text;
    return `${text.slice(0, maxLen - 1)}…`;
  };

  // Only take over the whole area with a spinner when we have nothing to show yet.
  // Once a tree has rendered, switching/refreshing worktrees dims it and overlays
  // a spinner instead, so the view doesn't blank out and lose context.
  if (isLoading && worktrees.length === 0) {
    return (
      <div className="canvas-container">
        <div className="empty-state">
          <RefreshCw className="empty-icon loading-spinner" size={48} />
          <p className="empty-title">Reading git repository...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="canvas-container">
      {isLoading && (
        <div className="canvas-loading-overlay">
          <RefreshCw className="loading-spinner" size={28} />
          <span>Refreshing worktrees...</span>
        </div>
      )}
      {worktrees.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">No worktrees detected</p>
          <p className="empty-desc">This shouldn't happen for a valid git repo. Make sure the repository exists.</p>
        </div>
      ) : (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className={`tree-svg ${isLoading ? 'is-loading' : ''}`}
        >
          {/* Definitions for SVG gradients and filters */}
          <defs>
            <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            <filter id="heavy-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Main Trunk shadow/glow */}
          <path
            d={`M ${rootX} ${rootY + 40} L ${rootX} ${trunkEndY - 20}`}
            className={`tree-branch-glow ${selectedWt?.is_main ? 'active' : ''}`}
            strokeWidth={14}
          />
          {/* Main Trunk */}
          <path
            d={`M ${rootX} ${rootY + 40} L ${rootX} ${trunkEndY - 20}`}
            className={`tree-branch ${selectedWt?.is_main ? 'active' : ''}`}
            strokeWidth={6}
          />

          {/* Render Additional Worktree Branches */}
          {branches.map((b, i) => {
            const isSelected = selectedWt?.path === b.wt.path;
            const isHovered = hoveredWt === b.wt.path;
            
            return (
              <g key={`branch-${i}`}>
                {/* Glow layer */}
                <path
                  d={b.pathD}
                  className={`tree-branch-glow ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''}`}
                  strokeWidth={10}
                />
                {/* Branch line */}
                <path
                  d={b.pathD}
                  className={`tree-branch ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''}`}
                  strokeWidth={3}
                />
              </g>
            );
          })}

          {/* Render Additional Worktree Nodes */}
          {branches.map((b, i) => {
            const isSelected = selectedWt?.path === b.wt.path;
            const statusClass = b.wt.is_clean ? 'clean' : 'dirty';
            const label = getBranchLabel(b.wt);
            const folder = getFolderLabel(b.wt.path);

            // Text alignment: shift text to avoid overlap
            const isLeft = b.leafX < rootX;
            const textAnchor = isLeft ? 'end' : 'start';
            // Stagger the label's distance from its node (alternating per index)
            // so labels on nearby branches don't sit directly on top of one another.
            const staggerDist = 18 + (i % 3) * 7;
            const textOffsetX = isLeft ? -staggerDist : staggerDist;

            return (
              <g
                key={`node-${i}`}
                className={`node-group ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectWt(b.wt, isLeft ? 'left' : 'right')}
                onMouseEnter={() => setHoveredWt(b.wt.path)}
                onMouseLeave={() => setHoveredWt(null)}
              >
                {/* Pulse Ring for Selected */}
                {isSelected && (
                  <circle
                    cx={b.leafX}
                    cy={b.leafY}
                    r={18}
                    className={`pulse-ring ${statusClass}`}
                    strokeWidth={1.5}
                  />
                )}
                {/* Inner Circle (Node) */}
                <circle
                  cx={b.leafX}
                  cy={b.leafY}
                  r={8}
                  className={`node-circle ${statusClass}`}
                  strokeWidth={2.5}
                  filter={isSelected || hoveredWt === b.wt.path ? 'url(#glow)' : undefined}
                />
                
                {/* Labels (truncated with a native tooltip for the full name) */}
                <text
                  x={b.leafX + textOffsetX}
                  y={b.leafY - 2}
                  textAnchor={textAnchor}
                  className="node-text"
                >
                  <title>{label}</title>
                  {truncateLabel(label)}
                </text>
                <text
                  x={b.leafX + textOffsetX}
                  y={b.leafY + 10}
                  textAnchor={textAnchor}
                  className="node-subtext"
                >
                  <title>{b.wt.path}</title>
                  {truncateLabel(folder)}
                </text>
              </g>
            );
          })}

          {/* Main Root Repository Worktree Node (Drawn on top so it overlaps trunk base) */}
          {mainWt && (() => {
            const isSelected = selectedWt?.path === mainWt.path;
            const label = getBranchLabel(mainWt);
            const folder = getFolderLabel(mainWt.path);

            return (
              <g
                className={`node-group ${isSelected ? 'selected' : ''}`}
                onClick={() => onSelectWt(mainWt, 'right')}
                onMouseEnter={() => setHoveredWt(mainWt.path)}
                onMouseLeave={() => setHoveredWt(null)}
              >
                {/* Pulsing ring for main selected */}
                {isSelected && (
                  <circle
                    cx={rootX}
                    cy={rootY}
                    r={22}
                    className="pulse-ring active-main"
                    strokeWidth={1.5}
                  />
                )}
                {/* Outer decorative ring for Root */}
                <circle
                  cx={rootX}
                  cy={rootY}
                  r={14}
                  fill="none"
                  stroke="rgba(0, 210, 255, 0.3)"
                  strokeWidth={1}
                />
                {/* Inner Root node */}
                <circle
                  cx={rootX}
                  cy={rootY}
                  r={10}
                  className="node-circle active-main"
                  strokeWidth={3}
                  filter={isSelected || hoveredWt === mainWt.path ? 'url(#heavy-glow)' : undefined}
                />
                
                {/* Root label below node */}
                <text
                  x={rootX}
                  y={rootY + 28}
                  textAnchor="middle"
                  className="node-text"
                  style={{ fontWeight: 'bold' }}
                >
                  <title>{label}</title>
                  {truncateLabel(label, 20)} (Root)
                </text>
                <text
                  x={rootX}
                  y={rootY + 38}
                  textAnchor="middle"
                  className="node-subtext"
                >
                  <title>{mainWt.path}</title>
                  {truncateLabel(folder, 20)}
                </text>
              </g>
            );
          })()}
        </svg>
      )}
    </div>
  );
};
