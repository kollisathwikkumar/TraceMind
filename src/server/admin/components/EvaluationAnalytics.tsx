import { useState } from 'react';
import type { AdminApi, EvaluationAnalytics } from '../api';

const METRICS = [
  [
    'rootCauseAccuracy',
    'Root-cause correctness',
    'Did the investigation identify the known cause?',
  ],
  ['evidencePrecision', 'Evidence precision', 'How much of the cited evidence was relevant?'],
  ['evidenceRecall', 'Evidence recall', 'How much relevant evidence was retrieved?'],
  ['retrievalQuality', 'Retrieval quality', 'Was useful incident memory ranked highly?'],
  [
    'fixOutcomeAccuracy',
    'Fix outcome accuracy',
    'Did the recorded fix outcome match ground truth?',
  ],
] as const;

export function EvaluationAnalyticsPage({ api }: { api: AdminApi }) {
  const [dataset, setDataset] = useState('');
  const [analytics, setAnalytics] = useState<EvaluationAnalytics | null>(null);
  const [cases, setCases] = useState<
    Array<{
      caseId: string;
      recordedAt: string;
      score: {
        baseline: Record<string, number | boolean>;
        graph: Record<string, number | boolean>;
      };
    }>
  >([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!dataset.trim()) return;
    setLoading(true);
    setError('');
    try {
      const [a, c] = await Promise.all([
        api.getEvaluationAnalytics(dataset.trim()),
        api.getEvaluationCases(dataset.trim()),
      ]);
      setAnalytics(a);
      setCases(c);
    } catch (e) {
      setAnalytics(null);
      setCases([]);
      setError(e instanceof Error ? e.message : 'Could not load evaluation data');
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="page-shell">
      <header className="page-heading">
        <div>
          <span className="eyebrow">EVALUATION DATA</span>
          <h1>Evaluation analytics</h1>
          <p>
            Compare graph-assisted investigations with baseline results from saved evaluation cases.
          </p>
        </div>
        <span className="live-indicator">
          <i /> PERSISTED RESULTS
        </span>
      </header>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      <section className="surface eval-toolbar">
        <form onSubmit={load}>
          <label>
            Dataset
            <input
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
              placeholder="Dataset ID"
            />
          </label>
          <button className="btn btn-primary" disabled={loading}>
            {loading ? 'Loading…' : 'Load evaluation'}
          </button>
        </form>
        <p>
          Metrics are aggregated from cases saved through <code>/api/v1/evaluations/cases</code>.
        </p>
      </section>
      {analytics ? (
        <>
          <div className="eval-summary">
            <div className="surface">
              <span className="eyebrow">RECORDED CASES</span>
              <strong>{analytics.cases}</strong>
              <small>{analytics.dataset}</small>
            </div>
            <div className="surface">
              <span className="eyebrow">GRAPH LIFT · ROOT CAUSE</span>
              <strong
                className={
                  analytics.graph.rootCauseAccuracy >= analytics.baseline.rootCauseAccuracy
                    ? 'lift-positive'
                    : 'lift-negative'
                }
              >
                {signed(
                  (analytics.graph.rootCauseAccuracy - analytics.baseline.rootCauseAccuracy) * 100
                )}{' '}
                pp
              </strong>
              <small>Graph vs baseline accuracy</small>
            </div>
            <div className="surface">
              <span className="eyebrow">OUTCOME LIFT</span>
              <strong
                className={
                  analytics.graph.fixOutcomeAccuracy >= analytics.baseline.fixOutcomeAccuracy
                    ? 'lift-positive'
                    : 'lift-negative'
                }
              >
                {signed(
                  (analytics.graph.fixOutcomeAccuracy - analytics.baseline.fixOutcomeAccuracy) * 100
                )}{' '}
                pp
              </strong>
              <small>Fix outcome accuracy</small>
            </div>
          </div>
          <section className="surface metrics-table">
            <div className="surface-heading">
              <div>
                <span className="eyebrow">BASELINE × GRAPH-ASSISTED</span>
                <h2>Quality comparison</h2>
              </div>
              <span className="depth-chip">0–100%</span>
            </div>
            <div className="metric-table-head">
              <span>Measure</span>
              <span>Baseline</span>
              <span>TraceMind graph</span>
              <span>Delta</span>
            </div>
            {METRICS.map(([key, label, description]) => {
              const b = analytics.baseline[key],
                g = analytics.graph[key],
                delta = (g - b) * 100;
              return (
                <div className="metric-row" key={key}>
                  <div>
                    <strong>{label}</strong>
                    <small>{description}</small>
                  </div>
                  <div className="metric-value">
                    <span>{percent(b)}</span>
                    <div className="meter">
                      <i style={{ width: `${Math.max(0, Math.min(100, b * 100))}%` }} />
                    </div>
                  </div>
                  <div className="metric-value graph-value">
                    <span>{percent(g)}</span>
                    <div className="meter">
                      <i style={{ width: `${Math.max(0, Math.min(100, g * 100))}%` }} />
                    </div>
                  </div>
                  <b className={delta >= 0 ? 'delta-up' : 'delta-down'}>{signed(delta)} pp</b>
                </div>
              );
            })}
          </section>
          <section className="surface case-table">
            <div className="surface-heading">
              <div>
                <span className="eyebrow">CASE-BY-CASE</span>
                <h2>Recorded evaluations</h2>
              </div>
              <span className="depth-chip">{cases.length} CASES</span>
            </div>
            {cases.length ? (
              <div className="case-list">
                {cases.map((c) => (
                  <div className="case-row" key={c.caseId}>
                    <code>{c.caseId}</code>
                    <span>
                      Root cause{' '}
                      <b>
                        {bool(c.score.baseline.rootCauseCorrect)} →{' '}
                        {bool(c.score.graph.rootCauseCorrect)}
                      </b>
                    </span>
                    <span>
                      Outcome{' '}
                      <b>
                        {bool(c.score.baseline.fixOutcomeCorrect)} →{' '}
                        {bool(c.score.graph.fixOutcomeCorrect)}
                      </b>
                    </span>
                    <small>{new Date(c.recordedAt).toLocaleDateString()}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty-state">No individual cases in this dataset.</p>
            )}
          </section>
        </>
      ) : (
        <section className="surface graph-empty">
          <div className="graph-empty-orbit">↗</div>
          <h2>Bring investigation results into focus</h2>
          <p>
            Choose a dataset and load saved case evaluations to compare diagnosis, evidence,
            retrieval, and fix outcomes.
          </p>
          <button className="btn btn-secondary" onClick={() => void load()} disabled={loading}>
            Load {dataset}
          </button>
        </section>
      )}
    </div>
  );
}
function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}
function signed(value: number) {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}
function bool(value: unknown) {
  return value === true ? 'Correct' : value === false ? 'Miss' : '—';
}
