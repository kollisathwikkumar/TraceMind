import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminApi, EvidencePath, Incident } from '../api';

type GraphNode = {
  id: string;
  label: string;
  kind: 'incident' | 'service';
  x: number;
  y: number;
  count: number;
};
type GraphEdge = { from: string; to: string; relationship: string; criticality?: string };

export function GraphEvidence({ api }: { api: AdminApi }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentId, setIncidentId] = useState('');
  const [depth, setDepth] = useState(3);
  const [paths, setPaths] = useState<EvidencePath[]>([]);
  const [selectedNode, setSelectedNode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number; startX: number; startY: number } | null>(
    null
  );
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    void api
      .getIncidents()
      .then((rows) => {
        setIncidents(rows);
        if (rows[0]) setIncidentId(rows[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  useEffect(() => {
    if (!incidentId) return;
    let live = true;
    setLoading(true);
    setError('');
    void api
      .getEvidencePaths(incidentId, depth)
      .then((data) => {
        if (live) {
          setPaths(data);
          setSelectedNode(incidentId);
          setPan({ x: 0, y: 0 });
          setScale(1);
        }
      })
      .catch((e: Error) => {
        if (live) {
          setPaths([]);
          setError(e.message);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, incidentId, depth]);

  const { nodes, edges } = useMemo(() => buildGraph(paths), [paths]);
  const selected = nodes.find((node) => node.id === selectedNode);
  const selectedPath = paths.find(
    (path) =>
      path.rootIncidentId === selectedNode ||
      path.incidentId === selectedNode ||
      path.services.some((service) => service.id === selectedNode)
  );
  const incident = incidents.find((item) => item.id === incidentId);

  const zoom = (amount: number) =>
    setScale((value) => Math.max(0.65, Math.min(2.25, value + amount)));
  const fit = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };
  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    zoom(event.deltaY < 0 ? 0.08 : -0.08);
  };

  return (
    <div className="page-shell graph-page">
      <header className="page-heading graph-page-heading">
        <div>
          <span className="eyebrow">FALKORDB · EVIDENCE GRAPH</span>
          <h1>Graph view</h1>
        </div>
        <form className="graph-toolbar" onSubmit={(event) => event.preventDefault()}>
          <label className="graph-select">
            <span className="sr-only">Incident</span>
            <select
              value={incidentId}
              onChange={(event) => setIncidentId(event.target.value)}
              aria-label="Select incident"
            >
              {incidents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          <label className="graph-select depth-select">
            <span className="sr-only">Traversal depth</span>
            <select
              value={depth}
              onChange={(event) => setDepth(Number(event.target.value))}
              aria-label="Traversal depth"
            >
              {[1, 2, 3, 4].map((value) => (
                <option key={value} value={value}>
                  {value} hops
                </option>
              ))}
            </select>
          </label>
          <span
            className={`graph-query-status ${loading ? 'is-loading' : paths.length ? 'is-ready' : ''}`}
            aria-live="polite"
          >
            <i />
            {loading ? 'Updating' : `${nodes.length} nodes`}
          </span>
        </form>
      </header>

      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <section className="graph-workspace" aria-label="Incident dependency graph">
        <div className="graph-stage">
          <div className="graph-stage-topline">
            <div className="graph-legend" aria-label="Graph legend">
              <span>
                <i className="legend-incident" />
                Incident
              </span>
              <span>
                <i className="legend-service" />
                Service
              </span>
            </div>
            <div className="graph-tools" aria-label="Graph controls">
              <button type="button" aria-label="Zoom out" onClick={() => zoom(-0.12)}>
                −
              </button>
              <span>{Math.round(scale * 100)}%</span>
              <button type="button" aria-label="Zoom in" onClick={() => zoom(0.12)}>
                +
              </button>
              <button type="button" className="fit-button" onClick={fit}>
                Fit
              </button>
            </div>
          </div>
          {!loading && !error && !incidentId ? (
            <div className="graph-blank-state">
              <div className="graph-blank-orbit" />
              <h2>No incidents to map</h2>
              <p>Create an incident to explore its connected services.</p>
            </div>
          ) : !loading && !error && paths.length === 0 ? (
            <div className="graph-blank-state">
              <div className="graph-blank-orbit" />
              <h2>No connected evidence</h2>
              <p>This incident has no related dependency paths at the selected depth.</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              className={`evidence-svg ${loading ? 'is-loading' : ''}`}
              viewBox="0 0 1000 620"
              role="img"
              aria-label={`Graph showing ${nodes.length} nodes and ${edges.length} database relationships`}
              onWheel={onWheel}
              onPointerDown={(event) => {
                const target = event.target;
                if (!(target instanceof Element) || !target.closest('.graph-node')) {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({ x: event.clientX, y: event.clientY, startX: pan.x, startY: pan.y });
                }
              }}
              onPointerMove={(event) => {
                if (drag)
                  setPan({
                    x: drag.startX + event.clientX - drag.x,
                    y: drag.startY + event.clientY - drag.y,
                  });
              }}
              onPointerUp={() => setDrag(null)}
              onPointerCancel={() => setDrag(null)}
            >
              <defs>
                <radialGradient id="graph-wash">
                  <stop stopColor="#e9f0ff" stopOpacity=".64" />
                  <stop offset="1" stopColor="#fff" stopOpacity="0" />
                </radialGradient>
              </defs>
              <ellipse cx="500" cy="310" rx="425" ry="275" fill="url(#graph-wash)" />
              <g
                transform={`translate(${pan.x} ${pan.y}) translate(500 310) scale(${scale}) translate(-500 -310)`}
              >
                {edges.map((edge, index) => {
                  const from = nodes.find((node) => node.id === edge.from);
                  const to = nodes.find((node) => node.id === edge.to);
                  if (!from || !to) return null;
                  const focused = edge.from === selectedNode || edge.to === selectedNode;
                  return (
                    <g
                      key={`${edge.from}-${edge.relationship}-${edge.to}-${index}`}
                      className={`graph-link ${focused ? 'is-focused' : ''}`}
                    >
                      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
                      <circle className="edge-pulse" r="2.5">
                        <animateMotion
                          dur={`${7 + (index % 5)}s`}
                          repeatCount="indefinite"
                          path={`M${from.x},${from.y} L${to.x},${to.y}`}
                        />
                      </circle>
                      <title>
                        {edge.relationship.replaceAll('_', ' ')}
                        {edge.criticality ? ` · ${edge.criticality}` : ''}
                      </title>
                    </g>
                  );
                })}
                {nodes.map((node, index) => {
                  const isSelected = selectedNode === node.id;
                  return (
                    <g
                      key={node.id}
                      className={`graph-node ${node.kind} ${isSelected ? 'is-selected' : ''}`}
                      transform={`translate(${node.x} ${node.y})`}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.kind}: ${node.label}`}
                      onClick={() => setSelectedNode(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedNode(node.id);
                        }
                      }}
                    >
                      <circle
                        className="node-halo"
                        r={node.kind === 'incident' ? 26 : 17}
                        style={{ animationDelay: `${(index % 8) * -0.4}s` }}
                      />
                      <circle className="node-core" r={node.kind === 'incident' ? 10 : 6} />
                      <text x={node.kind === 'incident' ? 18 : 12} y="4">
                        {node.label}
                      </text>
                      <title>
                        {node.kind === 'incident' ? 'Incident' : 'Service'} · {node.label}
                      </title>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {loading && <div className="graph-loading-line" />}
          <div className="graph-stage-foot">
            <span>{incident?.title || 'Select an incident'}</span>
            <span>Drag to move · scroll to zoom</span>
          </div>
        </div>
        <aside className="graph-inspector">
          <span className="eyebrow">INSPECT</span>
          {selected ? (
            <>
              <div className={`inspector-node-mark ${selected.kind}`}>
                <i />
              </div>
              <span className="inspector-kind">{selected.kind}</span>
              <h2>{selected.label}</h2>
              <code className="inspector-id">{selected.id}</code>
              <div className="inspector-rule" />
              <dl className="inspector-facts">
                <div>
                  <dt>Connections</dt>
                  <dd>
                    {
                      edges.filter((edge) => edge.from === selected.id || edge.to === selected.id)
                        .length
                    }
                  </dd>
                </div>
                {selectedPath?.rationale && (
                  <div className="inspector-rationale">
                    <dt>Path context</dt>
                    <dd>{selectedPath.rationale}</dd>
                  </div>
                )}
              </dl>
              {selected.kind === 'incident' && selected.id !== incidentId && (
                <a
                  className="inspector-link"
                  href={`#/incidents?selected=${encodeURIComponent(selected.id)}`}
                >
                  Open incident <span>↗</span>
                </a>
              )}
            </>
          ) : (
            <div className="inspector-empty">Select a node to inspect its connected evidence.</div>
          )}
          <div className="inspector-footer">
            <span>
              <i /> Live query
            </span>
            <span>{edges.length} relationships</span>
          </div>
        </aside>
      </section>
    </div>
  );
}

function buildGraph(paths: EvidencePath[]) {
  const rawEdges = paths.flatMap((path) => path.edges);
  const edgeMap = new Map<string, GraphEdge>();
  for (const edge of rawEdges) edgeMap.set(`${edge.from}|${edge.relationship}|${edge.to}`, edge);
  const edges = [...edgeMap.values()];
  const labels = new Map<string, { label: string; kind: GraphNode['kind']; count: number }>();
  for (const path of paths) {
    labels.set(path.rootIncidentId, { label: path.rootIncidentTitle, kind: 'incident', count: 0 });
    labels.set(path.incidentId, { label: path.incidentTitle, kind: 'incident', count: 0 });
    for (const service of path.services)
      labels.set(service.id, { label: service.name, kind: 'service', count: 0 });
  }
  for (const edge of edges) {
    if (labels.has(edge.from)) labels.get(edge.from)!.count++;
    if (labels.has(edge.to)) labels.get(edge.to)!.count++;
  }
  const rootIds = new Set(paths.map((path) => path.rootIncidentId));
  const relatedIds = new Set(paths.map((path) => path.incidentId));
  const serviceIds = [...labels]
    .filter(([, data]) => data.kind === 'service')
    .map(([id]) => id)
    .sort();
  const incidentIds = [...labels]
    .filter(([, data]) => data.kind === 'incident')
    .map(([id]) => id)
    .sort();
  const nodes: GraphNode[] = [...labels].map(([id, data]) => {
    let x: number;
    let y: number;
    if (rootIds.has(id)) {
      x = 115;
      y = 310 + (incidentIds.indexOf(id) - Math.floor(rootIds.size / 2)) * 74;
    } else if (relatedIds.has(id)) {
      x = 885;
      y = 310 + (incidentIds.indexOf(id) - Math.floor(incidentIds.length / 2)) * 74;
    } else {
      const index = serviceIds.indexOf(id);
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, serviceIds.length);
      const radiusX = serviceIds.length > 9 ? 210 : 170;
      const radiusY = Math.min(220, Math.max(100, serviceIds.length * 13));
      x = 500 + Math.cos(angle) * radiusX;
      y = 310 + Math.sin(angle) * radiusY;
    }
    return { id, ...data, x, y };
  });
  return { nodes, edges };
}
