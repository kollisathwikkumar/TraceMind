import { mkdtempSync, rmSync } from 'fs';
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
    const context = { incidentId: 'i-1', planId: 'p-1', stepId: 's-1' };
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
    await expect(workflow.execute(plan.id, step.id, 'operator')).rejects.toThrow('approval');
    store.decide(plan.id, step.id, 'approve', 'operator', 'Reviewed rollback and impact');
    const result = await workflow.execute(plan.id, step.id, 'operator');
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
      'operator',
      'Rollback if post-check regresses'
    );
    await expect(workflow.rollback(plan.id, step.id, 'operator')).resolves.toMatchObject({
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
    store.decide(plan.id, plan.steps[0].id, 'approve', 'operator', 'Approved');
    await expect(workflow.execute(plan.id, plan.steps[0].id, 'operator')).resolves.toMatchObject({
      executionSucceeded: true,
      verificationSucceeded: false,
      status: 'verification_failed',
    });
    store.close();
  });
});

describe('WorkflowStore evaluation analytics', () => {
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
