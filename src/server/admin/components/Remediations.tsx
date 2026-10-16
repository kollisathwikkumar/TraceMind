import { useEffect, useState } from 'react';
import type { AdminApi, Incident, RemediationPlan } from '../api';

export function Remediations({ api }: { api: AdminApi }) {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentId, setIncidentId] = useState('');
  const [planId, setPlanId] = useState('');
  const [plan, setPlan] = useState<RemediationPlan | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [actionId, setActionId] = useState('');
  const [checkId, setCheckId] = useState('');
  const [rollbackId, setRollbackId] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api
      .getIncidents()
      .then((rows) => {
        setIncidents(rows);
        if (rows[0]) setIncidentId(rows[0].id);
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const created = await api.createRemediation(incidentId, title, [
        { actionId, postCheckId: checkId, rollbackActionId: rollbackId, description },
      ]);
      setPlan(created);
      setPlanId(created.id);
      setNotice('Plan persisted. It is awaiting explicit approval.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plan creation failed');
    } finally {
      setBusy(false);
    }
  };
  const reload = async () => {
    if (!planId.trim()) return;
    setBusy(true);
    setError('');
    try {
      setPlan(await api.getRemediation(planId.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Plan could not be loaded');
    } finally {
      setBusy(false);
    }
  };
  const act = async (stepId: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      await reload();
      setNotice(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Workflow action failed');
    } finally {
      setBusy(false);
    }
  };
  const decide = (stepId: string, decision: 'approve' | 'reject', rollback = false) =>
    act(
      stepId,
      () => api.remediationDecision(plan!.id, stepId, decision, reason, rollback),
      rollback ? `Rollback ${decision}d and recorded.` : `Remediation ${decision}d and recorded.`
    );
  return (
    <div className="page-shell">
      <header className="page-heading">
        <div>
          <span className="eyebrow">CONTROLLED CHANGE · AUDIT TRAIL</span>
          <h1>Remediation workflow</h1>
          <p>
            Propose an allowlisted action, capture an engineer’s decision, execute only after
            approval, then verify the observed outcome.
          </p>
        </div>
        <span className="live-indicator">
          <i /> APPROVAL GATED
        </span>
      </header>
      {error && (
        <div role="alert" className="notice notice-error">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="notice notice-success">
          {notice}
        </div>
      )}
      <div className="workflow-grid">
        <section className="surface workflow-create">
          <div className="surface-heading">
            <div>
              <span className="eyebrow">01 / PROPOSE</span>
              <h2>New remediation plan</h2>
            </div>
            <span className="step-number">01</span>
          </div>
          <form className="form-stack" onSubmit={create}>
            <label>
              Incident
              <select required value={incidentId} onChange={(e) => setIncidentId(e.target.value)}>
                {incidents.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title} · {i.severity}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Plan title
              <input required value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              Action description
              <textarea
                rows={3}
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="form-two">
              <label>
                Registered action ID
                <input
                  required
                  value={actionId}
                  onChange={(e) => setActionId(e.target.value)}
                  placeholder="Registered executor action"
                />
              </label>
              <label>
                Post-check ID
                <input
                  required
                  value={checkId}
                  onChange={(e) => setCheckId(e.target.value)}
                  placeholder="Registered verification check"
                />
              </label>
            </div>
            <label>
              Rollback action ID
              <input
                required
                value={rollbackId}
                onChange={(e) => setRollbackId(e.target.value)}
                placeholder="Registered rollback action"
              />
            </label>
            <div className="inline-note">
              <b>Execution stays server-owned</b>
              <span>
                IDs must be registered by the backend executor. The browser submits identifiers and
                cannot send shell commands.
              </span>
            </div>
            <button className="btn btn-primary" disabled={busy || !incidentId}>
              {busy ? 'Saving…' : 'Create approval plan'} <span>↗</span>
            </button>
          </form>
        </section>
        <section className="surface plan-console">
          <div className="surface-heading">
            <div>
              <span className="eyebrow">02 / REVIEW & VERIFY</span>
              <h2>Plan console</h2>
            </div>
            <span className="step-number">02</span>
          </div>
          <form
            className="plan-load"
            onSubmit={(e) => {
              e.preventDefault();
              void reload();
            }}
          >
            <label htmlFor="plan-id">Plan ID</label>
            <input
              id="plan-id"
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
              placeholder="Paste a persisted plan ID"
            />
            <button className="btn btn-secondary" disabled={busy || !planId}>
              Load
            </button>
          </form>
          {plan ? (
            <>
              <div className="plan-summary">
                <div>
                  <span className="eyebrow">{plan.incidentId}</span>
                  <h3>{plan.title}</h3>
                </div>
                <code>{plan.id}</code>
              </div>
              <label className="reason-field">
                Approval / audit reason
                <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              {plan.steps.map((step) => (
                <article className="remediation-step" key={step.id}>
                  <div className="step-top">
                    <span className={`status-pill ${step.status}`}>
                      {step.status.replaceAll('_', ' ')}
                    </span>
                    <code>{step.id}</code>
                  </div>
                  <h3>{step.description}</h3>
                  <div className="action-ids">
                    <span>
                      Action <b>{step.actionId}</b>
                    </span>
                    <span>
                      Check <b>{step.postCheckId}</b>
                    </span>
                    <span>
                      Rollback <b>{step.rollbackActionId}</b>
                    </span>
                  </div>
                  <div className="step-controls">
                    {step.status === 'pending' && (
                      <>
                        <button
                          className="btn btn-primary"
                          disabled={busy}
                          onClick={() => void decide(step.id, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => void decide(step.id, 'reject')}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {step.status === 'approved' && (
                      <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            step.id,
                            () => api.executeRemediation(plan.id, step.id),
                            'Execution and post-check returned; see recorded result below.'
                          )
                        }
                      >
                        Execute approved action
                      </button>
                    )}
                    {['verified', 'verification_failed', 'execution_succeeded'].includes(
                      step.status
                    ) &&
                      !step.rollbackApproved && (
                        <button
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => void decide(step.id, 'approve', true)}
                        >
                          Approve rollback
                        </button>
                      )}
                    {step.rollbackApproved && (
                      <button
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(
                            step.id,
                            () => api.rollbackRemediation(plan.id, step.id),
                            'Rollback result recorded.'
                          )
                        }
                      >
                        Run approved rollback
                      </button>
                    )}
                  </div>
                  {step.executionResult && (
                    <div className="outcome-block">
                      <b>Execution · {step.executionResult.succeeded ? 'succeeded' : 'failed'}</b>
                      <p>
                        {step.executionResult.output ||
                          step.executionResult.error ||
                          'No output returned.'}
                      </p>
                    </div>
                  )}
                  {step.verificationResult && (
                    <div
                      className={`outcome-block ${step.verificationResult.succeeded ? 'outcome-good' : 'outcome-bad'}`}
                    >
                      <b>
                        Post-check ·{' '}
                        {step.verificationResult.succeeded ? 'verified' : 'not verified'}
                      </b>
                      <p>
                        {step.verificationResult.evidence ||
                          step.verificationResult.error ||
                          'No evidence returned.'}
                      </p>
                    </div>
                  )}
                  {step.rollbackResult && (
                    <div className="outcome-block">
                      <b>Rollback · {step.rollbackResult.succeeded ? 'succeeded' : 'failed'}</b>
                      <p>
                        {step.rollbackResult.output ||
                          step.rollbackResult.error ||
                          'No output returned.'}
                      </p>
                    </div>
                  )}
                </article>
              ))}
              {plan.events?.length > 0 && (
                <div className="audit-list">
                  <h3>Audit events</h3>
                  {plan.events.map((event) => (
                    <div className="audit-event" key={event.id}>
                      <span>{event.action.replaceAll('_', ' ')}</span>
                      <small>
                        {event.actor} · {new Date(event.createdAt).toLocaleString()}
                      </small>
                      <p>{event.detail}</p>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="graph-empty compact">
              <div className="graph-empty-orbit">✓</div>
              <h3>No plan loaded</h3>
              <p>
                Create a new plan or paste its stored ID to inspect approvals, execution and
                verification.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
