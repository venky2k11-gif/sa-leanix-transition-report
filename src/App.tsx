import { lx } from '@leanix/reporting';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';

const PROGRAMS = [
  'Aged Care', 'Centrelink', 'Child Support', 'Common Systems',
  'Corporate Systems', 'DVA', 'Medicare', 'NDIA', 'Payment Utility',
];

const PROGRAM_COLORS: Record<string, string> = {
  'Aged Care':         '#e67e22',
  'Centrelink':        '#2980b9',
  'Child Support':     '#27ae60',
  'Common Systems':    '#8e44ad',
  'Corporate Systems': '#c0392b',
  'DVA':               '#16a085',
  'Medicare':          '#2c3e50',
  'NDIA':              '#f39c12',
  'Payment Utility':   '#1abc9c',
};

interface AppItem {
  id: string;
  name: string;
  shortName: string;
  isCurrentState: boolean;
  isFutureState: boolean;
  program: string;
  lifecyclePhase: string;
  successorIds: string[];
  predecessorIds: string[];
}

interface LineData {
  fromId: string;
  toId: string;
  color: string;
  isPrimary: boolean;
}

const QUERY = `{
  allFactSheets(
    filter: { facetFilters: [{ facetKey: "FactSheetTypes", operator: OR, keys: ["Application"] }] }
    first: 500
  ) {
    edges {
      node {
        id name
        tags { name }
        ... on Application {
          lifecycle { phases { phase startDate } }
          relApplicationToOrganization {
            edges { node { factSheet { id name } } }
          }
          relToSuccessor {
            edges { node { factSheet { id name } } }
          }
          relToPredecessor {
            edges { node { factSheet { id name } } }
          }
        }
      }
    }
  }
}`;

function shortName(name: string): string {
  // Truncate long names for display: "A0P - SAP Decision Service Management 1.0" → "A0P - SAP Decision..."
  return name.length > 38 ? name.slice(0, 36) + '…' : name;
}

export default function App() {
  const [apps, setApps] = useState<Map<string, AppItem>>(new Map());
  const [loading, setLoading] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const cardRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const init = async () => {
      await lx.init();
      const result = await (lx as any).executeGraphQL(QUERY);
      const nodes: any[] = result?.allFactSheets?.edges?.map((e: any) => e.node) ?? [];

      const appMap = new Map<string, AppItem>();
      for (const node of nodes) {
        const tags: string[] = (node.tags || []).map((t: any) => t.name);
        if (!tags.includes('SA')) continue;
        const isCurrentState = tags.includes('Current State');
        const isFutureState = tags.includes('Future State');
        if (!isCurrentState && !isFutureState) continue;

        const orgEdges = node.relApplicationToOrganization?.edges ?? [];
        const program = orgEdges[0]?.node?.factSheet?.name ?? 'Unknown';

        const phases: any[] = node.lifecycle?.phases ?? [];
        const lifecyclePhase =
          phases.find((p) => p.phase === 'endOfLife') ? 'endOfLife' :
          phases.find((p) => p.phase === 'active')    ? 'active' : 'none';

        appMap.set(node.id, {
          id: node.id,
          name: node.name,
          shortName: shortName(node.name),
          isCurrentState,
          isFutureState,
          program,
          lifecyclePhase,
          successorIds: (node.relToSuccessor?.edges ?? []).map((e: any) => e.node.factSheet.id),
          predecessorIds: (node.relToPredecessor?.edges ?? []).map((e: any) => e.node.factSheet.id),
        });
      }

      setApps(appMap);
      setLoading(false);
      (lx as any).ready({});
    };
    init();
  }, []);

  // Update SVG size when container resizes
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        const r = containerRef.current.getBoundingClientRect();
        setSvgSize({ w: r.width, h: r.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Group current state by program
  const currentByProgram = useMemo(() => {
    const grouped = new Map<string, AppItem[]>();
    PROGRAMS.forEach(p => grouped.set(p, []));
    apps.forEach(app => {
      if (!app.isCurrentState) return;
      grouped.get(app.program)?.push(app);
    });
    return grouped;
  }, [apps]);

  // Group future state by program (derive program from predecessors)
  const futureByProgram = useMemo(() => {
    const grouped = new Map<string, AppItem[]>();
    PROGRAMS.forEach(p => grouped.set(p, []));
    apps.forEach(app => {
      if (!app.isFutureState) return;
      // Determine program from predecessor(s)
      const predPrograms = app.predecessorIds
        .map(id => apps.get(id)?.program)
        .filter(Boolean) as string[];
      const program = predPrograms[0] ?? app.program;
      grouped.get(program)?.push(app);
    });
    return grouped;
  }, [apps]);

  // Calculate which lines to draw when hovering
  const activeLines = useMemo<LineData[]>(() => {
    if (!hoveredId) return [];
    const hovered = apps.get(hoveredId);
    if (!hovered?.isCurrentState) return [];

    const lines: LineData[] = [];
    for (const successorId of hovered.successorIds) {
      const successor = apps.get(successorId);
      if (!successor) continue;
      // Draw lines from ALL predecessors of this successor (the whole merge group)
      for (const predId of successor.predecessorIds) {
        if (!apps.get(predId)) continue;
        const predProgram = apps.get(predId)?.program ?? '';
        lines.push({
          fromId: predId,
          toId: successorId,
          color: PROGRAM_COLORS[predProgram] ?? '#888888',
          isPrimary: predId === hoveredId,
        });
      }
    }
    return lines;
  }, [hoveredId, apps]);

  const getLinePoints = useCallback((fromId: string, toId: string) => {
    const container = containerRef.current;
    const fromEl = cardRefs.current.get(fromId);
    const toEl = cardRefs.current.get(toId);
    if (!container || !fromEl || !toEl) return null;
    const cr = container.getBoundingClientRect();
    const fr = fromEl.getBoundingClientRect();
    const tr = toEl.getBoundingClientRect();
    return {
      x1: fr.left + fr.width / 2 - cr.left,
      y1: fr.bottom - cr.top,
      x2: tr.left + tr.width / 2 - cr.left,
      y2: tr.top - cr.top,
    };
  }, []);

  // Highlighted IDs for styling
  const highlightedIds = useMemo(() => {
    return new Set(activeLines.map(l => l.fromId).concat(activeLines.map(l => l.toId)));
  }, [activeLines]);

  if (loading) {
    return <div className="loading">Loading SA transition data…</div>;
  }

  return (
    <div className="app" ref={containerRef}>
      {/* SVG overlay for hover lines */}
      <svg
        className="lines-svg"
        style={{ width: svgSize.w, height: svgSize.h }}
      >
        {activeLines.map(line => {
          const pts = getLinePoints(line.fromId, line.toId);
          if (!pts) return null;
          const midY = (pts.y1 + pts.y2) / 2;
          return (
            <path
              key={`${line.fromId}-${line.toId}`}
              d={`M ${pts.x1} ${pts.y1} C ${pts.x1} ${midY}, ${pts.x2} ${midY}, ${pts.x2} ${pts.y2}`}
              stroke={line.color}
              strokeWidth={line.isPrimary ? 2.5 : 1.5}
              strokeOpacity={line.isPrimary ? 1 : 0.45}
              strokeDasharray={line.isPrimary ? undefined : '5 3'}
              fill="none"
            />
          );
        })}
      </svg>

      {/* Current State section */}
      <div className="section-header current-header">
        <span className="section-badge current-badge">Current State</span>
        <div className="legend">
          <span className="legend-item active-dot">Active</span>
          <span className="legend-item eol-dot">End of Life</span>
          <span className="legend-item none-dot">No Lifecycle</span>
        </div>
      </div>
      <div className="programs-grid">
        {PROGRAMS.map(prog => (
          <div key={prog} className="program-col">
            <div
              className="program-header"
              style={{ borderColor: PROGRAM_COLORS[prog] }}
            >
              {prog}
            </div>
            <div className="cards-list">
              {(currentByProgram.get(prog) ?? [])
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(app => (
                  <div
                    key={app.id}
                    ref={el => { cardRefs.current.set(app.id, el); }}
                    className={[
                      'app-card',
                      `lc-${app.lifecyclePhase}`,
                      hoveredId === app.id ? 'hovered' : '',
                      highlightedIds.has(app.id) && hoveredId !== app.id ? 'in-group' : '',
                    ].join(' ')}
                    onMouseEnter={() => setHoveredId(app.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    title={app.name}
                  >
                    {app.shortName}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>

      {/* Divider */}
      <div className="section-divider">
        <span>Transition</span>
      </div>

      {/* Future State section */}
      <div className="section-header future-header">
        <span className="section-badge future-badge">Future State</span>
        <span className="hint">Hover over a Current State app to see its transition path</span>
      </div>
      <div className="programs-grid">
        {PROGRAMS.map(prog => (
          <div key={prog} className="program-col">
            <div className="cards-list">
              {(futureByProgram.get(prog) ?? [])
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(app => (
                  <div
                    key={app.id}
                    ref={el => { cardRefs.current.set(app.id, el); }}
                    className={[
                      'app-card',
                      'future-card',
                      highlightedIds.has(app.id) ? 'target-highlighted' : '',
                    ].join(' ')}
                    title={app.name}
                  >
                    {app.shortName}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
