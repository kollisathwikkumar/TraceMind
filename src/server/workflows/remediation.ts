import type { RemediationStep, WorkflowRepository } from './store';
import { randomUUID } from 'crypto';

export interface RemediationExecutor {
  execute(
    actionId: string,
    context: RemediationContext
  ): Promise<{ succeeded: boolean; output?: string; error?: string }>;
  verify(
    checkId: string,
    context: RemediationContext
  ): Promise<{ succeeded: boolean; evidence?: string; error?: string }>;
  rollback(
    actionId: string,
    context: RemediationContext
  ): Promise<{ succeeded: boolean; output?: string; error?: string }>;
}
export type RemediationContext = {
  incidentId: string;
  planId: string;
  stepId: string;
  /** Stable across retries of a single logical broker operation. */
  idempotencyKey: string;
};
type ActionHandler = (
  context: RemediationContext
) => Promise<{ succeeded: boolean; output?: string; error?: string }>;
type CheckHandler = (
  context: RemediationContext
) => Promise<{ succeeded: boolean; evidence?: string; error?: string }>;

/** Resolves action IDs through an explicit server-owned allowlist. */
export class RegisteredRemediationExecutor implements RemediationExecutor {
  constructor(
    private readonly actions: Readonly<Record<string, ActionHandler>>,
    private readonly checks: Readonly<Record<string, CheckHandler>>,
    private readonly rollbacks: Readonly<Record<string, ActionHandler>>
  ) {}
  execute(actionId: string, context: RemediationContext) {
    return this.action(actionId)(context);
  }
  verify(checkId: string, context: RemediationContext) {
    const check = this.checks[checkId];
    if (!Object.hasOwn(this.checks, checkId) || typeof check !== 'function')
      throw new Error('Post-check identifier is not registered');
    return check(context);
  }
  rollback(actionId: string, context: RemediationContext) {
    const rollback = this.rollbacks[actionId];
    if (!Object.hasOwn(this.rollbacks, actionId) || typeof rollback !== 'function')
      throw new Error('Rollback identifier is not registered');
    return rollback(context);
  }
  private action(id: string): ActionHandler {
    const action = this.actions[id];
    if (!Object.hasOwn(this.actions, id) || typeof action !== 'function')
      throw new Error('Action identifier is not registered');
    return action;
  }
}
export interface RemediationResult {
  executionSucceeded: boolean;
  verificationSucceeded: boolean | null;
  status: RemediationStep['status'];
  execution?: RemediationStep['executionResult'];
  verification?: RemediationStep['verificationResult'];
}

/** Runs only registered application actions; it never evaluates client-provided shell commands. */
export class RemediationWorkflow {
  constructor(
    private readonly store: WorkflowRepository,
    private readonly executor?: RemediationExecutor
  ) {}

  async execute(
    planId: string,
    stepId: string,
    actor: string,
    tenantId = 'default'
  ): Promise<RemediationResult> {
    if (!this.executor) throw new Error('No controlled remediation executor is configured');
    const plan = await this.store.getPlan(planId, tenantId);
    const step = plan?.steps.find((item) => item.id === stepId);
    if (!plan || !step) throw new Error('Remediation step not found');
    const leaseToken = randomUUID();
    if (
      step.status !== 'approved' ||
      !(await this.store.beginExecution(planId, stepId, actor, leaseToken, tenantId))
    )
      throw new Error('Remediation step requires approval before execution');
    const context: RemediationContext = {
      incidentId: plan.incidentId,
      planId,
      stepId,
      idempotencyKey: `${planId}:${stepId}:execute`,
    };
    let execution: RemediationStep['executionResult'];
    let outcomeUnknown = false;
    try {
      execution = boundResult(await this.executor.execute(step.actionId, context));
    } catch (error) {
      // A lost response does not prove the broker did not perform the action.
      // Keep the step out of rollback-eligible states until reconciled by key.
      outcomeUnknown = true;
      execution = { succeeded: false, error: `Execution outcome unknown: ${message(error)}` };
    }
    if (!execution.succeeded) {
      const persisted = await this.store.setExecution(
        planId,
        stepId,
        outcomeUnknown ? 'execution_unknown' : 'execution_failed',
        execution,
        undefined,
        actor,
        leaseToken,
        tenantId
      );
      if (!persisted) {
        return { executionSucceeded: false, verificationSucceeded: null, status: 'execution_unknown' };
      }
      return {
        executionSucceeded: false,
        verificationSucceeded: null,
        status: outcomeUnknown ? 'execution_unknown' : 'execution_failed',
        execution,
      };
    }
    let verification: RemediationStep['verificationResult'];
    let verificationUnknown = false;
    try {
      verification = boundResult(await this.executor.verify(step.postCheckId, context));
    } catch (error) {
      verificationUnknown = true;
      verification = { succeeded: false, error: `Verification outcome unknown: ${message(error)}` };
    }
    const status = verificationUnknown
      ? 'verification_unknown'
      : verification.succeeded ? 'verified' : 'verification_failed';
    const persisted = await this.store.setExecution(
      planId,
      stepId,
      status,
      execution,
      verification,
      actor,
      leaseToken,
      tenantId
    );
    if (!persisted) {
      return {
        executionSucceeded: true,
        verificationSucceeded: verificationUnknown ? null : verification.succeeded,
        status: 'execution_unknown',
        execution,
        verification,
      };
    }
    return {
      executionSucceeded: true,
      verificationSucceeded: verificationUnknown ? null : verification.succeeded,
      status,
      execution,
      verification,
    };
  }

  async rollback(
    planId: string,
    stepId: string,
    actor: string,
    tenantId = 'default'
  ): Promise<{ status: RemediationStep['status']; result: RemediationStep['rollbackResult'] }> {
    if (!this.executor) throw new Error('No controlled remediation executor is configured');
    const plan = await this.store.getPlan(planId, tenantId);
    const step = plan?.steps.find((item) => item.id === stepId);
    if (!plan || !step) throw new Error('Remediation step not found');
    if (!step.rollbackApproved) throw new Error('Rollback requires separate approval');
    const leaseToken = randomUUID();
    if (
      !['verified', 'verification_failed', 'execution_succeeded'].includes(step.status) ||
      !(await this.store.beginRollback(planId, stepId, actor, leaseToken, tenantId))
    )
      throw new Error('Rollback requires a completed execution and separate approval');
    let result: RemediationStep['rollbackResult'];
    let outcomeUnknown = false;
    try {
      result = boundResult(
        await this.executor.rollback(step.rollbackActionId, {
          incidentId: plan.incidentId,
          planId,
          stepId,
          idempotencyKey: `${planId}:${stepId}:rollback`,
        })
      );
    } catch (error) {
      result = { succeeded: false, error: message(error) };
      outcomeUnknown = true;
    }
    const persisted = await this.store.setRollback(planId, stepId, result, actor, leaseToken, tenantId, outcomeUnknown);
    return { status: persisted ? (outcomeUnknown ? 'rollback_unknown' : result.succeeded ? 'rolled_back' : 'rollback_failed') : 'rollback_unknown', result };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Controlled action failed';
}

function boundResult<T extends { output?: string; evidence?: string; error?: string }>(
  result: T
): T {
  return {
    ...result,
    ...(result.output !== undefined ? { output: result.output.slice(0, 4000) } : {}),
    ...(result.evidence !== undefined ? { evidence: result.evidence.slice(0, 4000) } : {}),
    ...(result.error !== undefined ? { error: result.error.slice(0, 500) } : {}),
  };
}
