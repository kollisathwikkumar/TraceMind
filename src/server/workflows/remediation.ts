import type { RemediationStep, WorkflowRepository } from './store';

export interface RemediationExecutor {
  execute(
    actionId: string,
    context: { incidentId: string; planId: string; stepId: string }
  ): Promise<{ succeeded: boolean; output?: string; error?: string }>;
  verify(
    checkId: string,
    context: { incidentId: string; planId: string; stepId: string }
  ): Promise<{ succeeded: boolean; evidence?: string; error?: string }>;
  rollback(
    actionId: string,
    context: { incidentId: string; planId: string; stepId: string }
  ): Promise<{ succeeded: boolean; output?: string; error?: string }>;
}
type RemediationContext = { incidentId: string; planId: string; stepId: string };
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
  execute(actionId: string, context: { incidentId: string; planId: string; stepId: string }) {
    return this.action(actionId)(context);
  }
  verify(checkId: string, context: { incidentId: string; planId: string; stepId: string }) {
    const check = this.checks[checkId];
    if (!Object.hasOwn(this.checks, checkId) || typeof check !== 'function')
      throw new Error('Post-check identifier is not registered');
    return check(context);
  }
  rollback(actionId: string, context: { incidentId: string; planId: string; stepId: string }) {
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

  async execute(planId: string, stepId: string, actor: string): Promise<RemediationResult> {
    if (!this.executor) throw new Error('No controlled remediation executor is configured');
    const plan = await this.store.getPlan(planId);
    const step = plan?.steps.find((item) => item.id === stepId);
    if (!plan || !step) throw new Error('Remediation step not found');
    if (step.status !== 'approved' || !(await this.store.beginExecution(planId, stepId, actor)))
      throw new Error('Remediation step requires approval before execution');
    const context = { incidentId: plan.incidentId, planId, stepId };
    let execution: RemediationStep['executionResult'];
    try {
      execution = boundResult(await this.executor.execute(step.actionId, context));
    } catch (error) {
      execution = { succeeded: false, error: message(error) };
    }
    if (!execution.succeeded) {
      await this.store.setExecution(
        planId,
        stepId,
        'execution_failed',
        execution,
        undefined,
        actor
      );
      return {
        executionSucceeded: false,
        verificationSucceeded: null,
        status: 'execution_failed',
        execution,
      };
    }
    let verification: RemediationStep['verificationResult'];
    try {
      verification = boundResult(await this.executor.verify(step.postCheckId, context));
    } catch (error) {
      verification = { succeeded: false, error: message(error) };
    }
    const status = verification.succeeded ? 'verified' : 'verification_failed';
    await this.store.setExecution(planId, stepId, status, execution, verification, actor);
    return {
      executionSucceeded: true,
      verificationSucceeded: verification.succeeded,
      status,
      execution,
      verification,
    };
  }

  async rollback(
    planId: string,
    stepId: string,
    actor: string
  ): Promise<{ status: RemediationStep['status']; result: RemediationStep['rollbackResult'] }> {
    if (!this.executor) throw new Error('No controlled remediation executor is configured');
    const plan = await this.store.getPlan(planId);
    const step = plan?.steps.find((item) => item.id === stepId);
    if (!plan || !step) throw new Error('Remediation step not found');
    if (!step.rollbackApproved) throw new Error('Rollback requires separate approval');
    if (
      !['verified', 'verification_failed', 'execution_succeeded'].includes(step.status) ||
      !(await this.store.beginRollback(planId, stepId, actor))
    )
      throw new Error('Rollback requires a completed execution and separate approval');
    let result: RemediationStep['rollbackResult'];
    try {
      result = boundResult(
        await this.executor.rollback(step.rollbackActionId, {
          incidentId: plan.incidentId,
          planId,
          stepId,
        })
      );
    } catch (error) {
      result = { succeeded: false, error: message(error) };
    }
    await this.store.setRollback(planId, stepId, result, actor);
    return { status: result.succeeded ? 'rolled_back' : 'rollback_failed', result };
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
