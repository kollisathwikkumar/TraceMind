import { useEffect, useState } from 'react';
import type { AdminApi, HealthData, Incident } from '../api';

export function Dashboard({ api }: { api: AdminApi }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<Record<string, number> | null>(null);
  const [services, setServices] = useState<string[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [error, setError] = useState('');
  const [modelCheck, setModelCheck] = useState<{
    provider: string;
    model: string;
    response: string;
  } | null>(null);
  const [modelCheckError, setModelCheckError] = useState('');
  const [checkingModel, setCheckingModel] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([api.getHealth(), api.getStats(), api.getServices(), api.getIncidents()])
      .then(([h, s, svc, incs]) => {
        if (live) {
          setHealth(h);
          setStats(s);
          setServices(svc);
          setIncidents(incs);
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [api]);
  const active = incidents.filter((i) => i.status !== 'resolved');
  const critical = active.filter((i) => i.severity === 'SEV-1').length;
  const totalDocs = Object.values(stats || {}).reduce((sum, n) => sum + n, 0);
  if (error)
    return (
      <div className="notice notice-error" role="alert">
        {error}
      </div>
    );
  if (!health || !stats) return <div className="loading">Loading incident intelligence…</div>;
  return (
    <div className="page-shell dashboard-page">
      <section className="hero-band">
        <div className="hero-message">
          <h1>
            See the signal. <em>Trace the cause.</em>
          </h1>
        </div>
        <div className="hero-actions">
          <a className="btn btn-primary" href="#/incidents">
            Open incident queue <span>↗</span>
          </a>
          <a className="text-action" href="#/graph">
            Explore service graph <span>→</span>
          </a>
        </div>
      </section>
      <div className="section-intro">
        <div>
          <span className="eyebrow">LIVE OPERATIONS</span>
          <h2>Situation overview</h2>
        </div>
        <a href="#/incidents" className="text-action">
          All incidents <span>→</span>
        </a>
      </div>
      <section className="ops-metrics">
        <article className="metric-tile metric-alert">
          <div className="metric-label">
            <span className="metric-symbol">!</span> ACTIVE INCIDENTS
          </div>
          <strong>{active.length.toString().padStart(2, '0')}</strong>
          <small>
            {critical ? `${critical} critical requiring attention` : 'Across all severities'}
          </small>
          <a href="#/incidents">Review queue ↗</a>
        </article>
        <article className="metric-tile">
          <div className="metric-label">
            <span className="metric-symbol">⌘</span> SERVICES IN MEMORY
          </div>
          <strong>{services.length.toString().padStart(2, '0')}</strong>
          <small>Discoverable through connected graph</small>
          <a href="#/graph">Explore dependencies ↗</a>
        </article>
        <article className="metric-tile">
          <div className="metric-label">
            <span className="metric-symbol">▤</span> KNOWLEDGE RECORDS
          </div>
          <strong>{totalDocs.toString().padStart(2, '0')}</strong>
          <small>Runbooks, postmortems, service notes</small>
          <a href="#/documents">Browse memory ↗</a>
        </article>
        <article className="metric-tile metric-api">
          <div className="metric-label">
            <span className="metric-symbol">⌁</span> API STATUS
          </div>
          <strong>
            <i className={health.status === 'ready' ? 'status-ready' : 'status-degraded'} />{' '}
            {health.status === 'ready' ? 'READY' : 'DEGRADED'}
          </strong>
          <small>
            {health.database === 'postgres'
              ? 'PostgreSQL'
              : health.database === 'sqlite'
                ? 'SQLite'
                : 'Database'}
            {' · '}
            {health.components?.graphStore === 'healthy'
              ? 'FalkorDB connected'
              : 'FalkorDB not configured'}
          </small>
          <a href="#/sources">Connection details ↗</a>
        </article>
      </section>
      <section
        className="surface"
        aria-labelledby="model-check-title"
        style={{ marginBottom: '24px' }}
      >
        <div className="surface-heading">
          <div>
            <span className="eyebrow">MODEL CONNECTIVITY</span>
            <h2 id="model-check-title">Validate AI response</h2>
          </div>
          <button
            className="btn btn-primary"
            type="button"
            disabled={checkingModel}
            onClick={() => {
              setCheckingModel(true);
              setModelCheck(null);
              setModelCheckError('');
              void api
                .validateLLM()
                .then(setModelCheck)
                .catch((e: Error) => setModelCheckError(e.message))
                .finally(() => setCheckingModel(false));
            }}
          >
            {checkingModel ? 'Checking provider…' : 'Test model connection'}
          </button>
        </div>
        <p className="muted">
          Sends a short test prompt to the configured provider and displays its actual response.
        </p>
        {modelCheck && (
          <div className="notice" role="status">
            Connected to {modelCheck.provider} · {modelCheck.model}
            <p>{modelCheck.response}</p>
          </div>
        )}
        {modelCheckError && (
          <p className="error-text" role="alert">
            {modelCheckError}
          </p>
        )}
      </section>
      <div className="dashboard-lower">
        <section className="surface recent-incidents">
          <div className="surface-heading">
            <div>
              <span className="eyebrow">NEEDS YOUR ATTENTION</span>
              <h2>Incident queue</h2>
            </div>
            <a href="#/incidents" className="text-action">
              View all →
            </a>
          </div>
          {active.length ? (
            active.slice(0, 4).map((incident) => (
              <a
                className="queue-row"
                href={`#/incidents?selected=${encodeURIComponent(incident.id)}`}
                key={incident.id}
              >
                <span className={`severity-mark ${incident.severity.toLowerCase()}`} />
                <span className="queue-copy">
                  <b>{incident.title}</b>
                  <small>
                    {incident.id} · {new Date(incident.updatedAt).toLocaleString()}
                  </small>
                </span>
                <span className={`status-pill ${incident.status}`}>{incident.status}</span>
                <span className="row-arrow">↗</span>
              </a>
            ))
          ) : (
            <div className="quiet-empty">
              <span>✓</span>
              <b>All clear for now</b>
              <p>No unresolved incidents. New events will appear here.</p>
            </div>
          )}
        </section>
        <section className="surface response-loop">
          <div className="surface-heading">
            <div>
              <span className="eyebrow">RESPONSE LOOP</span>
              <h2>From signal to certainty</h2>
            </div>
            <span className="loop-mark">∞</span>
          </div>
          <div className="loop-step">
            <span>01</span>
            <div>
              <b>Detect & scope</b>
              <small>Record the event and affected services</small>
            </div>
            <a href="#/incidents">↗</a>
          </div>
          <div className="loop-step">
            <span>02</span>
            <div>
              <b>Trace & compare</b>
              <small>Follow dependency paths and incident memory</small>
            </div>
            <a href="#/graph">↗</a>
          </div>
          <div className="loop-step">
            <span>03</span>
            <div>
              <b>Approve & verify</b>
              <small>Gate actions, then store observed outcomes</small>
            </div>
            <a href="#/remediations">↗</a>
          </div>
          <div className="loop-step">
            <span>04</span>
            <div>
              <b>Measure & learn</b>
              <small>Compare graph reasoning to baseline cases</small>
            </div>
            <a href="#/analytics">↗</a>
          </div>
        </section>
      </div>
      <section className="footer-strip">
        <span>TRACE THE PATH, NOT JUST THE ALERT.</span>
        <a href="#/analytics">
          See evaluation results <b>↗</b>
        </a>
      </section>
    </div>
  );
}
