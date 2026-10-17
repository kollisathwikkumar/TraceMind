import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type ActionOutcome = 'succeeded' | 'failed' | 'not_run';
export interface EvaluationVariantInput {
  rootCause: string;
  evidenceIds: string[];
  fixOutcome: ActionOutcome;
}
export interface EvaluationCaseInput {
  dataset: string;
  caseId: string;
  groundTruthRootCause: string;
  relevantEvidenceIds: string[];
  expectedFixOutcome: Exclude<ActionOutcome, 'not_run'>;
  baseline: EvaluationVariantInput;
  graph: EvaluationVariantInput;
}
export interface VariantScore {
  rootCauseCorrect: boolean;
  evidencePrecision: number;
  evidenceRecall: number;
  retrievalQuality: number;
  fixOutcomeCorrect: boolean;
}
export interface EvaluationScore {
  baseline: VariantScore;
  graph: VariantScore;
}
export interface RemediationStepInput {
  actionId: string;
  postCheckId: string;
  rollbackActionId: string;
  description: string;
}
export interface RemediationStep extends RemediationStepInput {
  id: string;
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'executing'
    | 'execution_unknown'
    | 'execution_failed'
    | 'execution_succeeded'
    | 'verified'
    | 'verification_failed'
    | 'verification_unknown'
    | 'rolling_back'
    | 'rollback_unknown'
    | 'rolled_back'
    | 'rollback_failed';
  rollbackApproved: boolean;
  approvedBy?: string;
  rollbackApprovedBy?: string;
  executedBy?: string;
  executionResult?: { succeeded: boolean; output?: string; error?: string };
  verificationResult?: { succeeded: boolean; evidence?: string; error?: string };
  verificationReconciledBy?: string;
  rollbackResult?: { succeeded: boolean; output?: string; error?: string };
}
export interface RemediationPlan {
  id: string;
  incidentId: string;
  title: string;
  createdAt: string;
  createdBy: string;
  steps: RemediationStep[];
}
export interface WorkflowEvent {
  id: number;
  planId: string;
  stepId: string | null;
  action: string;
  actor: string;
  detail: string;
  createdAt: string;
}
export interface EvaluationAnalytics {
  dataset: string;
  cases: number;
  baseline: {
    rootCauseAccuracy: number;
    evidencePrecision: number;
    evidenceRecall: number;
    retrievalQuality: number;
    fixOutcomeAccuracy: number;
  };
  graph: {
    rootCauseAccuracy: number;
    evidencePrecision: number;
    evidenceRecall: number;
    retrievalQuality: number;
    fixOutcomeAccuracy: number;
  };
}

/** Storage contract implemented by SQLite for local runs and PostgreSQL for deployments. */
export interface WorkflowRepository {
  checkHealth(): import('../incidents/store').Awaitable<void>;
  createPlan(
    incidentId: string,
    title: string,
    steps: RemediationStepInput[],
    createdBy: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<RemediationPlan>;
  getPlan(planId: string, tenantId?: string): import('../incidents/store').Awaitable<RemediationPlan | undefined>;
  decide(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<RemediationPlan | undefined>;
  decideRollback(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<RemediationPlan | undefined>;
  setExecution(
    planId: string,
    stepId: string,
    status: RemediationStep['status'],
    execution: RemediationStep['executionResult'],
    verification: RemediationStep['verificationResult'] | undefined,
    actor: string,
    leaseToken: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<boolean>;
  resolveUnknown(
    planId: string,
    stepId: string,
    operation: 'execute' | 'verify' | 'rollback',
    succeeded: boolean,
    evidence: string,
    actor: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<boolean>;
  setRollback(
    planId: string,
    stepId: string,
    result: RemediationStep['rollbackResult'],
    actor: string,
    leaseToken: string,
    tenantId?: string,
    outcomeUnknown?: boolean
  ): import('../incidents/store').Awaitable<boolean>;
  beginExecution(
    planId: string,
    stepId: string,
    actor: string,
    leaseToken: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<boolean>;
  beginRollback(
    planId: string,
    stepId: string,
    actor: string,
    leaseToken: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<boolean>;
  reconcileExpiredLeases(actor: string, now?: Date, tenantId?: string): import('../incidents/store').Awaitable<number>;
  events(planId: string, tenantId?: string): import('../incidents/store').Awaitable<WorkflowEvent[]>;
  recordEvaluation(
    input: EvaluationCaseInput,
    tenantId?: string
  ): import('../incidents/store').Awaitable<EvaluationScore>;
  getEvaluationAnalytics(
    dataset: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<EvaluationAnalytics>;
  listEvaluations(
    dataset: string,
    tenantId?: string
  ): import('../incidents/store').Awaitable<
    Array<{ caseId: string; recordedAt: string; score: EvaluationScore }>
  >;
  close(): import('../incidents/store').Awaitable<void>;
}

export function scoreEvaluationCase(input: EvaluationCaseInput): EvaluationScore {
  const score = (variant: EvaluationVariantInput): VariantScore => {
    const relevant = new Set(input.relevantEvidenceIds);
    const retrieved = new Set(variant.evidenceIds);
    const overlap = [...retrieved].filter((id) => relevant.has(id)).length;
    const precision = retrieved.size ? overlap / retrieved.size : 0;
    const recall = relevant.size ? overlap / relevant.size : 0;
    return {
      rootCauseCorrect: normalize(variant.rootCause) === normalize(input.groundTruthRootCause),
      evidencePrecision: precision,
      evidenceRecall: recall,
      retrievalQuality: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
      fixOutcomeCorrect: variant.fixOutcome === input.expectedFixOutcome,
    };
  };
  return { baseline: score(input.baseline), graph: score(input.graph) };
}

export class WorkflowStore {
  private readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS remediation_plans (
        id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, title TEXT NOT NULL,
        created_at TEXT NOT NULL, created_by TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE IF NOT EXISTS remediation_steps (
        id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES remediation_plans(id),
        action_id TEXT NOT NULL, post_check_id TEXT NOT NULL, rollback_action_id TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL, rollback_approved INTEGER NOT NULL DEFAULT 0,
        approved_by TEXT, rollback_approved_by TEXT, executed_by TEXT, lease_token TEXT, lease_expires_at TEXT,
        execution_result TEXT, verification_result TEXT, verification_reconciled_by TEXT, rollback_result TEXT,
        tenant_id TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY(plan_id, id)
      );
      CREATE TABLE IF NOT EXISTS remediation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, step_id TEXT,
        action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE IF NOT EXISTS evaluation_cases (
        dataset TEXT NOT NULL, case_id TEXT NOT NULL, input_json TEXT NOT NULL, score_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
        PRIMARY KEY(tenant_id, dataset, case_id)
      );
    `);
    for (const table of ['remediation_plans', 'remediation_steps', 'remediation_events', 'evaluation_cases'] as const) {
      const tableColumns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!tableColumns.some((column) => column.name === 'tenant_id')) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
      }
    }
    const evaluationColumns = this.db.prepare('PRAGMA table_info(evaluation_cases)').all() as Array<{ name: string; pk: number }>;
    const evaluationPrimaryKey = evaluationColumns.filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (evaluationPrimaryKey.join(',') !== 'tenant_id,dataset,case_id') {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE evaluation_cases RENAME TO evaluation_cases_legacy');
        this.db.exec(`
          CREATE TABLE evaluation_cases (
            dataset TEXT NOT NULL, case_id TEXT NOT NULL, input_json TEXT NOT NULL, score_json TEXT NOT NULL,
            recorded_at TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
            PRIMARY KEY(tenant_id,dataset,case_id)
          );
          INSERT INTO evaluation_cases(dataset,case_id,input_json,score_json,recorded_at,tenant_id)
            SELECT dataset,case_id,input_json,score_json,recorded_at,tenant_id FROM evaluation_cases_legacy;
          DROP TABLE evaluation_cases_legacy;
        `);
      })();
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS remediation_plans_tenant ON remediation_plans(tenant_id, id);
      CREATE INDEX IF NOT EXISTS remediation_events_tenant ON remediation_events(tenant_id, plan_id, id);
      CREATE INDEX IF NOT EXISTS evaluation_cases_tenant ON evaluation_cases(tenant_id, dataset, case_id);
    `);
    const columns = this.db.prepare('PRAGMA table_info(remediation_steps)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'approved_by')) {
      this.db.exec('ALTER TABLE remediation_steps ADD COLUMN approved_by TEXT');
    }
    if (!columns.some((column) => column.name === 'rollback_approved_by')) {
      this.db.exec('ALTER TABLE remediation_steps ADD COLUMN rollback_approved_by TEXT');
    }
    if (!columns.some((column) => column.name === 'executed_by')) {
      this.db.exec('ALTER TABLE remediation_steps ADD COLUMN executed_by TEXT');
    }
    if (!columns.some((column) => column.name === 'lease_token')) {
      this.db.exec('ALTER TABLE remediation_steps ADD COLUMN lease_token TEXT');
    }
    if (!columns.some((column) => column.name === 'lease_expires_at')) {
      this.db.exec('ALTER TABLE remediation_steps ADD COLUMN lease_expires_at TEXT');
    }
    if (!columns.some((column) => column.name === 'verification_reconciled_by')) {
      this.db.exec('ALTER TABLE remediation_steps ADD COLUMN verification_reconciled_by TEXT');
    }
  }
  checkHealth(): void {
    this.db.prepare('SELECT 1').get();
  }

  createPlan(
    incidentId: string,
    title: string,
    steps: RemediationStepInput[],
    createdBy: string,
    tenantId = 'default'
  ): RemediationPlan {
    if (!steps.length) throw new Error('A remediation plan must include at least one step');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const plan: RemediationPlan = {
      id,
      incidentId,
      title: title.trim(),
      createdAt,
      createdBy,
      steps: steps.map((step) => ({
        ...step,
        id: randomUUID(),
        status: 'pending',
        rollbackApproved: false,
      })),
    };
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO remediation_plans (id,incident_id,title,created_at,created_by,tenant_id) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, incidentId, plan.title, createdAt, createdBy, tenantId);
      const insert = this.db.prepare(
        'INSERT INTO remediation_steps (id, plan_id, action_id, post_check_id, rollback_action_id, description, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const step of plan.steps) {
        insert.run(
          step.id,
          id,
          step.actionId,
          step.postCheckId,
          step.rollbackActionId,
          step.description,
          'pending',
          tenantId
        );
        this.addEvent(id, step.id, 'proposed', createdBy, step.description, tenantId);
      }
    })();
    return plan;
  }

  getPlan(planId: string, tenantId = 'default'): RemediationPlan | undefined {
    const plan = this.db.prepare('SELECT * FROM remediation_plans WHERE id=? AND tenant_id=?').get(planId, tenantId) as
      | PlanRow
      | undefined;
    if (!plan) return undefined;
    const steps = this.db
      .prepare('SELECT * FROM remediation_steps WHERE plan_id=? AND tenant_id=? ORDER BY rowid')
      .all(planId, tenantId) as StepRow[];
    return {
      id: plan.id,
      incidentId: plan.incident_id,
      title: plan.title,
      createdAt: plan.created_at,
      createdBy: plan.created_by,
      steps: steps.map(mapStep),
    };
  }

  decide(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string,
    tenantId = 'default'
  ): RemediationPlan | undefined {
    const step = this.getStep(planId, stepId, tenantId);
    if (!step) return undefined;
    const plan = this.getPlan(planId, tenantId);
    if (decision === 'approve' && actor === plan?.createdBy) {
      throw new Error('Remediation proposer cannot approve their own plan');
    }
    if (step.status !== 'pending')
      throw new Error('Only pending remediation steps can be approved or rejected');
    if (!reason.trim()) throw new Error('Approval or rejection reason is required');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status=?, approved_by=? WHERE plan_id=? AND id=? AND tenant_id=? AND status='pending'"
        )
        .run(status, decision === 'approve' ? actor : null, planId, stepId, tenantId);
      if (!result.changes)
        throw new Error('Only pending remediation steps can be approved or rejected');
      this.addEvent(
        planId,
        stepId,
        decision === 'approve' ? 'approved' : 'rejected',
        actor,
        reason.trim(),
        tenantId
      );
    })();
    return this.getPlan(planId, tenantId);
  }

  decideRollback(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string,
    tenantId = 'default'
  ): RemediationPlan | undefined {
    const step = this.getStep(planId, stepId, tenantId);
    if (!step) return undefined;
    if (
      decision === 'approve' &&
      (actor === step.approvedBy || actor === step.executedBy || actor === step.verificationReconciledBy || actor === this.getPlan(planId, tenantId)?.createdBy)
    ) {
      throw new Error('Rollback proposer, approver, executor, and verification reconciler must be different');
    }
    if (!['execution_succeeded', 'verified', 'verification_failed'].includes(step.status))
      throw new Error('Rollback approval requires an executed remediation step');
    if (!reason.trim()) throw new Error('Rollback decision reason is required');
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE remediation_steps SET rollback_approved=?, rollback_approved_by=? WHERE plan_id=? AND id=? AND tenant_id=?')
        .run(decision === 'approve' ? 1 : 0, decision === 'approve' ? actor : null, planId, stepId, tenantId);
      this.addEvent(
        planId,
        stepId,
        decision === 'approve' ? 'rollback_approved' : 'rollback_rejected',
        actor,
        reason.trim(),
        tenantId
      );
    })();
    return this.getPlan(planId, tenantId);
  }

  setExecution(
    planId: string,
    stepId: string,
    status: RemediationStep['status'],
    execution: RemediationStep['executionResult'],
    verification: RemediationStep['verificationResult'] | undefined,
    actor: string,
    leaseToken: string,
    tenantId = 'default'
  ): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status=?, execution_result=?, verification_result=?, lease_token=NULL, lease_expires_at=NULL WHERE plan_id=? AND id=? AND tenant_id=? AND status='executing' AND lease_token=?"
        )
        .run(
          status,
          execution ? JSON.stringify(execution) : null,
          verification ? JSON.stringify(verification) : null,
          planId,
          stepId,
          tenantId,
          leaseToken
        );
      if (!result.changes) return false;
      this.addEvent(
        planId,
        stepId,
        status === 'execution_failed' ? 'execution_failed' : 'executed',
        actor,
        execution?.succeeded
          ? 'Registered action reported success'
          : 'Registered action reported failure',
        tenantId
      );
      if (verification)
        this.addEvent(
          planId,
          stepId,
          status === 'verification_unknown'
            ? 'post_check_unknown'
            : verification.succeeded ? 'post_check_passed' : 'post_check_failed',
          actor,
          status === 'verification_unknown'
            ? 'Post-action check transport outcome unknown; reconciliation required'
            : verification.succeeded ? 'Post-action check passed' : 'Post-action check failed',
          tenantId
        );
      return true;
    })();
  }

  resolveUnknown(
    planId: string,
    stepId: string,
    operation: 'execute' | 'verify' | 'rollback',
    succeeded: boolean,
    evidence: string,
    actor: string,
    tenantId = 'default'
  ): boolean {
    const trimmedEvidence = evidence.trim().slice(0, 4000);
    if (!trimmedEvidence) throw new Error('Reconciliation evidence is required');
    return this.db.transaction(() => {
      const roles = this.db.prepare(`
        SELECT p.created_by,s.approved_by,s.rollback_approved_by,s.executed_by,
          (SELECT actor FROM remediation_events e WHERE e.plan_id=s.plan_id AND e.step_id=s.id
            AND e.action='rollback_started' AND e.tenant_id=s.tenant_id ORDER BY e.id DESC LIMIT 1) AS rollback_executor
        FROM remediation_steps s JOIN remediation_plans p ON p.id=s.plan_id AND p.tenant_id=s.tenant_id
        WHERE s.plan_id=? AND s.id=? AND s.tenant_id=?
      `).get(planId, stepId, tenantId) as { created_by: string; approved_by: string | null; rollback_approved_by: string | null; executed_by: string | null; rollback_executor: string | null } | undefined;
      if (!roles || [roles.created_by, roles.approved_by, roles.rollback_approved_by, roles.executed_by, roles.rollback_executor].includes(actor)) return false;
      const status = operation === 'execute'
        ? (succeeded ? 'execution_succeeded' : 'execution_failed')
        : operation === 'verify'
          ? (succeeded ? 'verified' : 'verification_failed')
          : (succeeded ? 'rolled_back' : 'rollback_failed');
      const update = operation === 'execute'
        ? this.db.prepare("UPDATE remediation_steps SET status=?,execution_result=?,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=? AND id=? AND tenant_id=? AND status='execution_unknown'")
          .run(status, JSON.stringify({ succeeded, output: `Operator reconciliation: ${trimmedEvidence}` }), planId, stepId, tenantId)
        : operation === 'verify'
          ? this.db.prepare("UPDATE remediation_steps SET status=?,verification_result=?,verification_reconciled_by=?,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=? AND id=? AND tenant_id=? AND status='verification_unknown'")
            .run(status, JSON.stringify({ succeeded, evidence: trimmedEvidence }), actor, planId, stepId, tenantId)
          : this.db.prepare("UPDATE remediation_steps SET status=?,rollback_result=?,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=? AND id=? AND tenant_id=? AND status='rollback_unknown'")
          .run(status, JSON.stringify({ succeeded, output: `Operator reconciliation: ${trimmedEvidence}` }), planId, stepId, tenantId);
      if (!update.changes) return false;
      this.addEvent(planId, stepId, `${operation}_reconciled`, actor, `${operation} outcome recorded as ${succeeded ? 'succeeded' : 'failed'}; evidence: ${trimmedEvidence}`, tenantId);
      return true;
    })();
  }

  setRollback(
    planId: string,
    stepId: string,
    result: RemediationStep['rollbackResult'],
    actor: string,
    leaseToken: string,
    tenantId = 'default',
    outcomeUnknown = false
  ): boolean {
    const status = outcomeUnknown ? 'rollback_unknown' : result?.succeeded ? 'rolled_back' : 'rollback_failed';
    return this.db.transaction(() => {
      const update = this.db
        .prepare(
          "UPDATE remediation_steps SET status=?, rollback_result=?, lease_token=NULL, lease_expires_at=NULL WHERE plan_id=? AND id=? AND tenant_id=? AND status='rolling_back' AND lease_token=?"
        )
        .run(status, JSON.stringify(result || {}), planId, stepId, tenantId, leaseToken);
      if (!update.changes) return false;
      this.addEvent(
        planId,
        stepId,
        status,
        actor,
        outcomeUnknown
          ? 'Rollback transport outcome unknown; manual reconciliation required'
          : result?.succeeded
          ? 'Registered rollback action reported success'
          : 'Registered rollback action reported failure',
        tenantId
      );
      return true;
    })();
  }

  beginExecution(planId: string, stepId: string, actor: string, leaseToken: string, tenantId = 'default'): boolean {
    const plan = this.getPlan(planId, tenantId);
    const step = this.getStep(planId, stepId, tenantId);
    if (plan?.createdBy === actor) throw new Error('Remediation proposer cannot execute the plan');
    if (step?.approvedBy === actor)
      throw new Error('Remediation approver and executor must be different');
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status='executing', executed_by=?, lease_token=?, lease_expires_at=? WHERE plan_id=? AND id=? AND tenant_id=? AND status='approved' AND approved_by<>? AND EXISTS (SELECT 1 FROM remediation_plans WHERE id=? AND tenant_id=? AND created_by<>?)"
        )
        .run(
          actor,
          leaseToken,
          new Date(Date.now() + 60_000).toISOString(),
          planId,
          stepId,
          tenantId,
          actor,
          planId,
          tenantId,
          actor
        );
      if (result.changes)
        this.addEvent(
          planId,
          stepId,
          'execution_started',
          actor,
          'Approved action execution started',
          tenantId
        );
      return result.changes === 1;
    })();
  }

  beginRollback(planId: string, stepId: string, actor: string, leaseToken: string, tenantId = 'default'): boolean {
    const step = this.getStep(planId, stepId, tenantId);
    const plan = this.getPlan(planId, tenantId);
    if (
      !step || !plan || !step.rollbackApproved || !step.rollbackApprovedBy ||
      step.rollbackApprovedBy === step.verificationReconciledBy ||
      actor === plan.createdBy || actor === step.approvedBy || actor === step.executedBy || actor === step.rollbackApprovedBy || actor === step.verificationReconciledBy
    ) return false;
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status='rolling_back', lease_token=?, lease_expires_at=? WHERE plan_id=? AND id=? AND tenant_id=? AND rollback_approved=1 AND rollback_approved_by IS NOT NULL AND (verification_reconciled_by IS NULL OR verification_reconciled_by<>rollback_approved_by) AND (verification_reconciled_by IS NULL OR verification_reconciled_by<>?) AND status IN ('verified','verification_failed','execution_succeeded')"
        )
        .run(
          leaseToken,
          new Date(Date.now() + 60_000).toISOString(),
          planId,
          stepId,
          tenantId,
          actor
        );
      if (result.changes)
        this.addEvent(
          planId,
          stepId,
          'rollback_started',
          actor,
          'Separately approved rollback started',
          tenantId
        );
      return result.changes === 1;
    })();
  }

  reconcileExpiredLeases(actor: string, now = new Date(), tenantId?: string): number {
    return this.db.transaction(() => {
      const expired = this.db
        .prepare(
          "SELECT plan_id, id, status, tenant_id FROM remediation_steps WHERE (? IS NULL OR tenant_id=?) AND status IN ('executing','rolling_back') AND lease_expires_at < ?"
        )
        .all(tenantId ?? null, tenantId ?? null, now.toISOString()) as Array<{ plan_id: string; id: string; status: string; tenant_id: string }>;
      const update = this.db.prepare(
        "UPDATE remediation_steps SET status=?, lease_token=NULL, lease_expires_at=NULL WHERE plan_id=? AND id=? AND tenant_id=? AND status IN ('executing','rolling_back')"
      );
      for (const row of expired) {
        const status = row.status === 'executing' ? 'execution_unknown' : 'rollback_unknown';
        update.run(status, row.plan_id, row.id, row.tenant_id);
        this.addEvent(
          row.plan_id,
          row.id,
          'lease_expired',
          actor,
          `In-flight ${row.status} attempt expired; outcome requires reconciliation`,
          row.tenant_id
        );
      }
      return expired.length;
    })();
  }

  events(planId: string, tenantId = 'default'): WorkflowEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM remediation_events WHERE plan_id=? AND tenant_id=? ORDER BY id')
        .all(planId, tenantId) as EventRow[]
    ).map(mapEvent);
  }

  recordEvaluation(input: EvaluationCaseInput, tenantId = 'default'): EvaluationScore {
    const score = scoreEvaluationCase(input);
    this.db
      .prepare(
        `INSERT INTO evaluation_cases (dataset, case_id, input_json, score_json, recorded_at, tenant_id)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, dataset, case_id) DO UPDATE SET input_json=excluded.input_json, score_json=excluded.score_json, recorded_at=excluded.recorded_at`
      )
      .run(
        input.dataset,
        input.caseId,
        JSON.stringify(input),
        JSON.stringify(score),
        new Date().toISOString(),
        tenantId
      );
    return score;
  }

  getEvaluationAnalytics(dataset: string, tenantId = 'default'): EvaluationAnalytics {
    const rows = this.db
      .prepare('SELECT score_json FROM evaluation_cases WHERE dataset=? AND tenant_id=?')
      .all(dataset, tenantId) as Array<{ score_json: string }>;
    const fields = [
      'rootCauseCorrect',
      'evidencePrecision',
      'evidenceRecall',
      'retrievalQuality',
      'fixOutcomeCorrect',
    ] as const;
    const aggregate = (variant: 'baseline' | 'graph') => {
      const totals = Object.fromEntries(fields.map((field) => [field, 0])) as Record<
        (typeof fields)[number],
        number
      >;
      for (const row of rows) {
        const score = JSON.parse(row.score_json) as EvaluationScore;
        for (const field of fields) totals[field] += Number(score[variant][field]);
      }
      const mean = (field: (typeof fields)[number]) =>
        rows.length ? totals[field] / rows.length : 0;
      return {
        rootCauseAccuracy: mean('rootCauseCorrect'),
        evidencePrecision: mean('evidencePrecision'),
        evidenceRecall: mean('evidenceRecall'),
        retrievalQuality: mean('retrievalQuality'),
        fixOutcomeAccuracy: mean('fixOutcomeCorrect'),
      };
    };
    return {
      dataset,
      cases: rows.length,
      baseline: aggregate('baseline'),
      graph: aggregate('graph'),
    };
  }

  listEvaluations(
    dataset: string,
    tenantId = 'default'
  ): Array<{ caseId: string; recordedAt: string; score: EvaluationScore }> {
    return (
      this.db
        .prepare(
          'SELECT case_id, recorded_at, score_json FROM evaluation_cases WHERE dataset=? AND tenant_id=? ORDER BY case_id'
        )
        .all(dataset, tenantId) as Array<{ case_id: string; recorded_at: string; score_json: string }>
    ).map((row) => ({
      caseId: row.case_id,
      recordedAt: row.recorded_at,
      score: JSON.parse(row.score_json) as EvaluationScore,
    }));
  }

  close(): void {
    this.db.close();
  }
  private getStep(planId: string, stepId: string, tenantId = 'default'): RemediationStep | undefined {
    const row = this.db
      .prepare('SELECT * FROM remediation_steps WHERE plan_id=? AND id=? AND tenant_id=?')
      .get(planId, stepId, tenantId) as StepRow | undefined;
    return row ? mapStep(row) : undefined;
  }
  private addEvent(
    planId: string,
    stepId: string | null,
    action: string,
    actor: string,
    detail: string,
    tenantId = 'default'
  ): void {
    this.db
      .prepare(
        'INSERT INTO remediation_events (plan_id, step_id, action, actor, detail, created_at, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(planId, stepId, action, actor, detail, new Date().toISOString(), tenantId);
  }
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
type PlanRow = {
  id: string;
  incident_id: string;
  title: string;
  created_at: string;
  created_by: string;
};
type StepRow = {
  id: string;
  action_id: string;
  post_check_id: string;
  rollback_action_id: string;
  description: string;
  status: RemediationStep['status'];
  rollback_approved: number;
  approved_by: string | null;
  rollback_approved_by: string | null;
  verification_reconciled_by: string | null;
  executed_by: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  execution_result: string | null;
  verification_result: string | null;
  rollback_result: string | null;
};
type EventRow = {
  id: number;
  plan_id: string;
  step_id: string | null;
  action: string;
  actor: string;
  detail: string;
  created_at: string;
};
function mapStep(row: StepRow): RemediationStep {
  return {
    id: row.id,
    actionId: row.action_id,
    postCheckId: row.post_check_id,
    rollbackActionId: row.rollback_action_id,
    description: row.description,
    status: row.status,
    rollbackApproved: row.rollback_approved === 1,
    ...(row.approved_by ? { approvedBy: row.approved_by } : {}),
    ...(row.rollback_approved_by ? { rollbackApprovedBy: row.rollback_approved_by } : {}),
    ...(row.verification_reconciled_by ? { verificationReconciledBy: row.verification_reconciled_by } : {}),
    ...(row.executed_by ? { executedBy: row.executed_by } : {}),
    ...(row.execution_result
      ? { executionResult: JSON.parse(row.execution_result) as RemediationStep['executionResult'] }
      : {}),
    ...(row.verification_result
      ? {
          verificationResult: JSON.parse(
            row.verification_result
          ) as RemediationStep['verificationResult'],
        }
      : {}),
    ...(row.rollback_result
      ? { rollbackResult: JSON.parse(row.rollback_result) as RemediationStep['rollbackResult'] }
      : {}),
  };
}
function mapEvent(row: EventRow): WorkflowEvent {
  return {
    id: row.id,
    planId: row.plan_id,
    stepId: row.step_id,
    action: row.action,
    actor: row.actor,
    detail: row.detail,
    createdAt: row.created_at,
  };
}
