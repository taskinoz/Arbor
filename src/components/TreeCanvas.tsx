import React, { useState, useRef, useEffect } from 'react';
import { WorktreeInfo } from '../types';
import { RefreshCw, Plus, Minus, Maximize2, Search, X } from 'lucide-react';
import { toDisplayPath } from '../utils/path';

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 3;
const DEFAULT_VIEW = { x: 0, y: 0, zoom: 1 };

interface TreeCanvasProps {
  worktrees: WorktreeInfo[];
  selectedWt: WorktreeInfo | null;
  onSelectWt: (wt: WorktreeInfo, side: 'left' | 'right') => void;
  isLoading: boolean;
  homeDir: string | null;
}

export const TreeCanvas: React.FC<TreeCanvasProps> = ({
  worktrees,
  selectedWt,
  onSelectWt,
  isLoading,
  homeDir,
}) => {
  const [hoveredWt, setHoveredWt] = useState<string | null>(null);

  // Dimensions of the tree's own coordinate space (node layout math below is
  // all relative to this - unchanged regardless of pan/zoom/padding).
  const width = 650;
  const height = 500;

  // Extra breathing room around the tree itself, so the outermost branches
  // and their labels aren't crammed against the edge of the canvas.
  const padX = 180;
  const padY = 140;
  const viewBox = `${-padX} ${-padY} ${width + padX * 2} ${height + padY * 2}`;

  // Pan/zoom state, in the tree's own coordinate space. Lets the canvas be
  // dragged around and scrolled/pinched to zoom, like Google Maps or an
  // Excalidraw board.
  const [view, setView] = useState(DEFAULT_VIEW);
  const [isPanning, setIsPanning] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // The <svg> only mounts once worktrees have loaded (there's an earlier
  // loading-state return with no svg at all), so a plain useEffect(fn, [])
  // attached before that point would find svgRef.current still null and
  // never get a chance to run again. Tracking the node in state instead lets
  // the wheel-listener effect below re-run exactly when the svg mounts.
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  const setSvgRef = (node: SVGSVGElement | null) => {
    svgRef.current = node;
    setSvgEl(node);
  };
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const lastWorldRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);

  // Converts a point in screen space (clientX/clientY) into the SVG's own
  // (pre pan/zoom) coordinate space, accounting for however the browser is
  // currently scaling/letterboxing the viewBox into the element's box.
  const getWorldPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const transformed = pt.matrixTransform(ctm.inverse());
    return { x: transformed.x, y: transformed.y };
  };

  const handlePointerMove = (e: MouseEvent) => {
    if (!draggingRef.current) return;
    const world = getWorldPoint(e.clientX, e.clientY);
    const dx = world.x - lastWorldRef.current.x;
    const dy = world.y - lastWorldRef.current.y;
    if (Math.hypot(dx, dy) > 0.5) movedRef.current = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    lastWorldRef.current = world;
  };

  const handlePointerUp = () => {
    draggingRef.current = false;
    setIsPanning(false);
    window.removeEventListener('mousemove', handlePointerMove);
    window.removeEventListener('mouseup', handlePointerUp);
    if (movedRef.current) {
      // A drag just happened - swallow the click that follows so it doesn't
      // also get treated as a node selection.
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  const handlePointerDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    draggingRef.current = true;
    movedRef.current = false;
    setIsPanning(true);
    lastWorldRef.current = getWorldPoint(e.clientX, e.clientY);
    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
  };

  // Wheel/trackpad zoom, anchored on the cursor so the point under it stays
  // put - registered natively so we can preventDefault (React's onWheel is
  // passive by default and can't stop the page from scrolling).
  useEffect(() => {
    if (!svgEl) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const world = getWorldPoint(e.clientX, e.clientY);
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.0015);
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
        const scaleChange = nextZoom / v.zoom;
        return {
          zoom: nextZoom,
          x: world.x - (world.x - v.x) * scaleChange,
          y: world.y - (world.y - v.y) * scaleChange,
        };
      });
    };
    svgEl.addEventListener('wheel', handleWheel, { passive: false });
    return () => svgEl.removeEventListener('wheel', handleWheel);
  }, [svgEl]);

  const zoomBy = (factor: number) => {
    setView((v) => {
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const scaleChange = nextZoom / v.zoom;
      // Anchor on the center of the tree's own coordinate space.
      const cx = width / 2;
      const cy = height / 2;
      return {
        zoom: nextZoom,
        x: cx - (cx - v.x) * scaleChange,
        y: cy - (cy - v.y) * scaleChange,
      };
    });
  };

  const resetView = () => setView(DEFAULT_VIEW);

  // Search filters which branches show up as leaves on the tree - the root
  // stays visible either way, as the tree's anchor.
  const [searchQuery, setSearchQuery] = useState('');
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const matchesQuery = (wt: WorktreeInfo) => {
    if (!trimmedQuery) return true;
    const branch = (wt.branch || 'detached').toLowerCase();
    const folder = wt.path.split('/').pop()?.toLowerCase() || '';
    return branch.includes(trimmedQuery) || folder.includes(trimmedQuery);
  };

  // Replays the "grow" animation whenever a fresh tree appears after being
  // empty (e.g. switching repos) - not on every minor refresh, since the <g>
  // below is only remounted (via its key) on that empty -> populated edge.
  const hadWorktreesRef = useRef(false);
  const [treeKey, setTreeKey] = useState(0);
  useEffect(() => {
    if (!hadWorktreesRef.current && worktrees.length > 0) {
      setTreeKey((k) => k + 1);
    }
    hadWorktreesRef.current = worktrees.length > 0;
  }, [worktrees.length]);

  // Separate main worktree and additional worktrees
  const mainWt = worktrees.find((w) => w.is_main) || worktrees[0];
  const additionalWts = worktrees.filter((w) => w !== mainWt && matchesQuery(w));

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

  // Remote status takes priority over the clean/dirty coloring - a branch
  // with no remote, or whose remote was deleted, is more important to flag
  // at a glance than whether it has local changes.
  const getStatusClass = (wt: WorktreeInfo) => {
    if (wt.remote_status === 'remote_gone') return 'remote-gone';
    if (wt.remote_status === 'no_remote') return 'no-remote';
    return wt.is_clean ? 'clean' : 'dirty';
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
          ref={setSvgRef}
          viewBox={viewBox}
          className={`tree-svg ${isLoading ? 'is-loading' : ''} ${isPanning ? 'panning' : ''}`}
          onMouseDown={handlePointerDown}
          onDoubleClick={resetView}
        >
          {/* Definitions for SVG gradients and filters */}
          <defs>
            <filter id="glow" x="-150%" y="-150%" width="400%" height="400%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
            <filter id="heavy-glow" x="-200%" y="-200%" width="500%" height="500%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Pan/zoom group - everything below moves and scales together */}
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>

          {/* Remounted (via key) only when a fresh tree appears after being
              empty, so the trunk/branches/nodes draw themselves in once per
              repo load instead of replaying on every minor refresh. */}
          <g key={treeKey} className="tree-grow">

          {/* Main Trunk shadow/glow */}
          <path
            d={`M ${rootX} ${rootY + 40} L ${rootX} ${trunkEndY - 20}`}
            className={`tree-branch-glow ${selectedWt?.is_main ? 'active' : ''}`}
            strokeWidth={14}
          />
          {/* Main Trunk */}
          <path
            d={`M ${rootX} ${rootY + 40} L ${rootX} ${trunkEndY - 20}`}
            className={`tree-branch tree-grow-draw ${selectedWt?.is_main ? 'active' : ''}`}
            strokeWidth={6}
            pathLength={1}
            style={{ animationDelay: '0ms' }}
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
                  className={`tree-branch tree-grow-draw ${isSelected ? 'active' : ''} ${isHovered ? 'hovered' : ''}`}
                  strokeWidth={3}
                  pathLength={1}
                  style={{ animationDelay: `${400 + i * 70}ms` }}
                />
              </g>
            );
          })}

          {/* Render Additional Worktree Nodes */}
          {branches.map((b, i) => {
            const isSelected = selectedWt?.path === b.wt.path;
            const statusClass = getStatusClass(b.wt);
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
                className={`node-group tree-grow-pop ${isSelected ? 'selected' : ''}`}
                style={{ animationDelay: `${680 + i * 70}ms` }}
                onClick={() => {
                  if (suppressClickRef.current) return;
                  onSelectWt(b.wt, isLeft ? 'left' : 'right');
                }}
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
                
                {/* Labels (truncated with a native tooltip for the full name).
                    Folder name is primary and branch name secondary - it's
                    what you'd actually navigate to on disk. */}
                <text
                  x={b.leafX + textOffsetX}
                  y={b.leafY - 2}
                  textAnchor={textAnchor}
                  className="node-text"
                >
                  <title>{toDisplayPath(b.wt.path, homeDir)}</title>
                  {truncateLabel(folder)}
                </text>
                <text
                  x={b.leafX + textOffsetX}
                  y={b.leafY + 10}
                  textAnchor={textAnchor}
                  className="node-subtext"
                >
                  <title>{label}</title>
                  {truncateLabel(label)}
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
                className={`node-group tree-grow-pop ${isSelected ? 'selected' : ''}`}
                style={{ animationDelay: '300ms' }}
                onClick={() => {
                  if (suppressClickRef.current) return;
                  onSelectWt(mainWt, 'right');
                }}
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
                
                {/* Root label below node - folder name primary (Root), branch secondary */}
                <text
                  x={rootX}
                  y={rootY + 28}
                  textAnchor="middle"
                  className="node-text"
                  style={{ fontWeight: 'bold' }}
                >
                  <title>{toDisplayPath(mainWt.path, homeDir)}</title>
                  {truncateLabel(folder, 20)} (Root)
                </text>
                <text
                  x={rootX}
                  y={rootY + 38}
                  textAnchor="middle"
                  className="node-subtext"
                >
                  <title>{label}</title>
                  {truncateLabel(label, 20)}
                </text>
              </g>
            );
          })()}
          </g>
          </g>
        </svg>
      )}
      {worktrees.length > 1 && (
        <div className="canvas-search">
          <Search size={14} className="canvas-search-icon" />
          <input
            type="text"
            className="canvas-search-input"
            placeholder="Search branches..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button
              type="button"
              className="canvas-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
              title="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      )}
      {worktrees.length > 0 && trimmedQuery && additionalWts.length === 0 && (
        <div className="canvas-search-empty">No branches match "{searchQuery.trim()}"</div>
      )}
      {worktrees.length > 0 && (
        <div className="canvas-zoom-controls">
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in">
            <Plus size={16} />
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out" title="Zoom out">
            <Minus size={16} />
          </button>
          <button type="button" onClick={resetView} aria-label="Reset view" title="Reset position & zoom">
            <Maximize2 size={16} />
          </button>
        </div>
      )}
    </div>
  );
};
