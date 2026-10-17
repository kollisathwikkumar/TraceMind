import { mkdtempSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RegisteredRemediationExecutor,
  RemediationWorkflow,
  type RemediationExecutor,
} from './workflows/remediation';
import { WorkflowStore, scoreEvaluationCase, type EvaluationCaseInput } from './workflows/store';

const dirs: string[] = [];
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tracemind-workflows-'));
  dirs.push(dir);
  return new WorkflowStore(join(dir, 'incidents.sqlite'));
}
const caseInput: EvaluationCaseInput = {
  dataset: 'known-incidents-v1',
  caseId: 'case-1',
  groundTruthRootCause: 'db-pool',
  relevantEvidenceIds: ['metric-1', 'log-1'],
  expectedFixOutcome: 'succeeded',
  baseline: { rootCause: 'timeout', evidenceIds: ['metric-1'], fixOutcome: 'failed' },
  graph: { rootCause: 'db-pool', evidenceIds: ['metric-1', 'log-1'], fixOutcome: 'succeeded' },
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('evaluation scoring', () => {
  it('compares graph and baseline against known root cause, evidence, and actual fix outcomes', () => {
    expect(scoreEvaluationCase(caseInput)).toMatchObject({
      baseline: {
        rootCauseCorrect: false,
        evidencePrecision: 1,
        evidenceRecall: 0.5,
        fixOutcomeCorrect: false,
      },
      graph: {
        rootCauseCorrect: true,
        evidencePrecision: 1,
        evidenceRecall: 1,
        fixOutcomeCorrect: true,
      },
    });
  });
});

describe('RemediationWorkflow', () => {
  it('resolves action, check, and rollback identifiers only from server-owned registries', async () => {
    const executor = new RegisteredRemediationExecutor(
      { 'service.restart': async () => ({ succeeded: true }) },
      { 'service.healthy': async () => ({ succeeded: true, evidence: 'healthy' }) },
      { 'service.restore': async () => ({ succeeded: true }) }
    );
    const context = {
      incidentId: 'i-1',
      planId: 'p-1',
      stepId: 's-1',
      idempotencyKey: 'p-1:s-1:execute',
    };
    await expect(executor.execute('service.restart', context)).resolves.toMatchObject({
      succeeded: true,
    });
    await expect(executor.verify('service.healthy', context)).resolves.toMatchObject({
      evidence: 'healthy',
    });
    expect(() => executor.execute('rm -rf /', context)).toThrow('not registered');
  });

  it('requires approval, executes only registered action, verifies outcome, and records rollback path', async () => {
    const store = makeStore();
    const executor: RemediationExecutor = {
      execute: vi.fn().mockResolvedValue({ succeeded: true, output: 'pool limit increased' }),
      verify: vi.fn().mockResolvedValue({ succeeded: true, evidence: 'connection saturation 61%' }),
      rollback: vi.fn().mockResolvedValue({ succeeded: true, output: 'previous limit restored' }),
    };
    const workflow = new RemediationWorkflow(store, executor);
    const plan = store.createPlan(
      'inc-1',
      'raise pool capacity',
      [
        {
          actionId: 'payments.pool.raise',
          postCheckId: 'payments.pool.verify',
          rollbackActionId: 'payments.pool.restore',
          description: 'Raise pool capacity',
        },
      ],
      'operator'
    );
    const step = plan.steps[0];
    await expect(workflow.execute(plan.id, step.id, 'executor')).rejects.toThrow('approval');
    store.decide(plan.id, step.id, 'approve', 'approver', 'Reviewed rollback and impact');
    const result = await workflow.execute(plan.id, step.id, 'executor');
    expect(result).toMatchObject({
      executionSucceeded: true,
      verificationSucceeded: true,
      status: 'verified',
    });
    expect(executor.execute).toHaveBeenCalledWith('payments.pool.raise', expect.any(Object));
    store.decideRollback(
      plan.id,
      step.id,
      'approve',
      'rollback-approver',
      'Rollback if post-check regresses'
    );
    const rawDb = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db;
    rawDb.prepare('UPDATE remediation_steps SET rollback_approved_by=NULL WHERE plan_id=? AND id=?').run(plan.id, step.id);
    expect(store.beginRollback(plan.id, step.id, 'legacy-rollback-executor', 'legacy-lease')).toBe(false);
    rawDb.prepare('UPDATE remediation_steps SET rollback_approved_by=? WHERE plan_id=? AND id=?').run('rollback-approver', plan.id, step.id);
    await expect(workflow.rollback(plan.id, step.id, 'rollback-approver')).rejects.toThrow(
      'separate approval'
    );
    await expect(workflow.rollback(plan.id, step.id, 'rollback-executor')).resolves.toMatchObject({
      status: 'rolled_back',
    });
    expect(store.events(plan.id).map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'approved',
        'executed',
        'post_check_passed',
        'rollback_approved',
        'rolled_back',
      ])
    );
    store.close();
  });

  it('fences late execution completions after a lease has been reconciled', () => {
    const store = makeStore();
    const plan = store.createPlan(
      'inc-lease',
      'leased action',
      [{ actionId: 'a', postCheckId: 'c', rollbackActionId: 'r', description: 'leased' }],
      'requester'
    );
    const step = plan.steps[0];
    store.decide(plan.id, step.id, 'approve', 'approver', 'approved');
    const leaseToken = 'late-completion-token';
    expect(store.beginExecution(plan.id, step.id, 'executor', leaseToken)).toBe(true);
    expect(store.reconcileExpiredLeases('reconciler', new Date(Date.now() + 120_000))).toBe(1);
    expect(
      store.setExecution(
        plan.id,
        step.id,
        'verified',
        { succeeded: true, output: 'late result' },
        { succeeded: true, evidence: 'late check' },
        'executor',
        leaseToken
      )
    ).toBe(false);
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('execution_unknown');
    store.close();
  });

  it('keeps a lost broker response unknown and preserves its idempotency key for reconciliation', async () => {
    const store = makeStore();
    const executor: RemediationExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('broker response timed out')),
      verify: vi.fn(),
      rollback: vi.fn(),
    };
    const workflow = new RemediationWorkflow(store, executor);
    const plan = store.createPlan(
      'inc-ambiguous',
      'possibly applied action',
      [{ actionId: 'action', postCheckId: 'check', rollbackActionId: 'rollback', description: 'ambiguous' }],
      'proposer'
    );
    const step = plan.steps[0];
    store.decide(plan.id, step.id, 'approve', 'approver', 'approved');

    await expect(workflow.execute(plan.id, step.id, 'executor')).resolves.toMatchObject({
      status: 'execution_unknown',
      verificationSucceeded: null,
    });
    const context = vi.mocked(executor.execute).mock.calls[0][1];
    expect(context.idempotencyKey).toBe(`${plan.id}:${step.id}:execute`);
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('execution_unknown');
    expect(() => store.decideRollback(plan.id, step.id, 'approve', 'rollback-approver', 'not reconciled'))
      .toThrow('executed remediation step');
    expect(store.resolveUnknown(plan.id, step.id, 'execute', true, 'Broker lookup found idempotency key applied; post-check evidence confirmed', 'incident-responder')).toBe(true);
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('execution_succeeded');
    expect(store.events(plan.id).some((event) => event.action === 'execute_reconciled' && event.actor === 'incident-responder')).toBe(true);
    store.close();
  });

  it('keeps a lost rollback response unknown until an operator reconciles it', async () => {
    const store = makeStore();
    const executor: RemediationExecutor = {
      execute: vi.fn().mockResolvedValue({ succeeded: true }),
      verify: vi.fn().mockResolvedValue({ succeeded: true, evidence: 'healthy' }),
      rollback: vi.fn().mockRejectedValue(new Error('rollback response timed out')),
    };
    const workflow = new RemediationWorkflow(store, executor);
    const plan = store.createPlan('inc-rb-unknown', 'rollback ambiguity', [
      { actionId: 'action', postCheckId: 'check', rollbackActionId: 'rollback', description: 'bounded action' },
    ], 'proposer');
    const step = plan.steps[0];
    store.decide(plan.id, step.id, 'approve', 'approver', 'approved');
    await workflow.execute(plan.id, step.id, 'executor');
    store.decideRollback(plan.id, step.id, 'approve', 'rollback-approver', 'approved rollback');
    const result = await workflow.rollback(plan.id, step.id, 'rollback-executor');
    expect(result.status).toBe('rollback_unknown');
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('rollback_unknown');
    expect(store.resolveUnknown(plan.id, step.id, 'rollback', true, 'Broker idempotency key confirms rollback completed', 'operator')).toBe(true);
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('rolled_back');
    expect(store.events(plan.id).some((event) => event.action === 'rollback_reconciled')).toBe(true);
    store.close();
  });

  it('keeps an ambiguous post-check non-rollbackable until verification is reconciled', async () => {
    const store = makeStore();
    const executor: RemediationExecutor = {
      execute: vi.fn().mockResolvedValue({ succeeded: true, output: 'action applied' }),
      verify: vi.fn().mockRejectedValue(new Error('health check response timed out')),
      rollback: vi.fn().mockResolvedValue({ succeeded: true }),
    };
    const workflow = new RemediationWorkflow(store, executor);
    const plan = store.createPlan('inc-verify-unknown', 'ambiguous check', [
      { actionId: 'action', postCheckId: 'check', rollbackActionId: 'rollback', description: 'bounded action' },
    ], 'proposer');
    const step = plan.steps[0];
    store.decide(plan.id, step.id, 'approve', 'approver', 'approved');
    const result = await workflow.execute(plan.id, step.id, 'executor');
    expect(result).toMatchObject({ status: 'verification_unknown', executionSucceeded: true, verificationSucceeded: null });
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('verification_unknown');
    expect(() => store.decideRollback(plan.id, step.id, 'approve', 'rollback-approver', 'check outcome unknown'))
      .toThrow('Rollback approval requires an executed remediation step');
    expect(store.resolveUnknown(plan.id, step.id, 'verify', true, 'Independent health check confirmed success', 'reconciler')).toBe(true);
    expect(store.getPlan(plan.id)?.steps[0].status).toBe('verified');
    expect(store.getPlan(plan.id)?.steps[0].verificationReconciledBy).toBe('reconciler');
    expect(store.events(plan.id).some((event) => event.action === 'post_check_unknown')).toBe(true);
    expect(store.events(plan.id).some((event) => event.action === 'verify_reconciled' && event.actor === 'reconciler')).toBe(true);
    expect(() => store.decideRollback(plan.id, step.id, 'approve', 'reconciler', 'same person'))
      .toThrow('verification reconciler');
    store.decideRollback(plan.id, step.id, 'approve', 'rollback-approver', 'Different approver');
    (store as unknown as { db: Database.Database }).db.prepare(
      'UPDATE remediation_steps SET rollback_approved_by=? WHERE plan_id=? AND id=?'
    ).run('reconciler', plan.id, step.id);
    expect(store.beginRollback(plan.id, step.id, 'rollback-executor', 'same-approval-lease')).toBe(false);
    (store as unknown as { db: Database.Database }).db.prepare(
      'UPDATE remediation_steps SET rollback_approved_by=? WHERE plan_id=? AND id=?'
    ).run('rollback-approver', plan.id, step.id);
    expect(store.beginRollback(plan.id, step.id, 'reconciler', 'same-person-lease')).toBe(false);
    expect(store.beginRollback(plan.id, step.id, 'rollback-executor', 'different-person-lease')).toBe(true);
    store.close();
  });

  it('records execution separately from a failed post-action check', async () => {
    const store = makeStore();
    const executor: RemediationExecutor = {
      execute: vi.fn().mockResolvedValue({ succeeded: true, output: 'command accepted' }),
      verify: vi
        .fn()
        .mockResolvedValue({ succeeded: false, evidence: 'error rate still elevated' }),
      rollback: vi.fn(),
    };
    const workflow = new RemediationWorkflow(store, executor);
    const plan = store.createPlan(
      'inc-2',
      'restart worker',
      [
        {
          actionId: 'worker.restart',
          postCheckId: 'worker.healthy',
          rollbackActionId: 'worker.restore',
          description: 'Restart worker',
        },
      ],
      'operator'
    );
    store.decide(plan.id, plan.steps[0].id, 'approve', 'approver', 'Approved');
    await expect(workflow.execute(plan.id, plan.steps[0].id, 'executor')).resolves.toMatchObject({
      executionSucceeded: true,
      verificationSucceeded: false,
      status: 'verification_failed',
    });
    store.close();
  });
});

describe('WorkflowStore evaluation analytics', () => {
  it('adds a nullable verification reconciler field without changing legacy approvals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracemind-legacy-workflow-'));
    dirs.push(dir);
    const path = join(dir, 'legacy.sqlite');
    const legacyDb = new Database(path);
    legacyDb.exec(`
      CREATE TABLE remediation_steps (
        id TEXT NOT NULL, plan_id TEXT NOT NULL, action_id TEXT NOT NULL, post_check_id TEXT NOT NULL,
        rollback_action_id TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL,
        rollback_approved INTEGER NOT NULL DEFAULT 0, approved_by TEXT, rollback_approved_by TEXT,
        executed_by TEXT, lease_token TEXT, lease_expires_at TEXT, execution_result TEXT,
        verification_result TEXT, rollback_result TEXT, tenant_id TEXT NOT NULL DEFAULT 'default'
      );
      INSERT INTO remediation_steps(id,plan_id,action_id,post_check_id,rollback_action_id,description,status,rollback_approved,rollback_approved_by,tenant_id)
        VALUES('legacy-step','legacy-plan','a','c','r','legacy','verified',1,'legacy-approver','default');
    `);
    legacyDb.close();
    const store = new WorkflowStore(path);
    const rawDb = (store as unknown as { db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } } }).db;
    expect(rawDb.prepare('SELECT rollback_approved,rollback_approved_by,verification_reconciled_by FROM remediation_steps WHERE id=?').get('legacy-step'))
      .toEqual({ rollback_approved: 1, rollback_approved_by: 'legacy-approver', verification_reconciled_by: null });
    store.close();
  });

  it('persists paired case scores and aggregates graph-versus-baseline metrics', () => {
    const store = makeStore();
    store.recordEvaluation(caseInput);
    const analytics = store.getEvaluationAnalytics('known-incidents-v1');
    expect(analytics).toMatchObject({
      cases: 1,
      baseline: {
        rootCauseAccuracy: 0,
        evidencePrecision: 1,
        evidenceRecall: 0.5,
        fixOutcomeAccuracy: 0,
      },
      graph: {
        rootCauseAccuracy: 1,
        evidencePrecision: 1,
        evidenceRecall: 1,
        fixOutcomeAccuracy: 1,
      },
    });
    store.close();
  });
});
