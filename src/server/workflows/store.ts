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
    | 'execution_failed'
    | 'execution_succeeded'
    | 'verified'
    | 'verification_failed'
    | 'rolling_back'
    | 'rolled_back'
    | 'rollback_failed';
  rollbackApproved: boolean;
  executionResult?: { succeeded: boolean; output?: string; error?: string };
  verificationResult?: { succeeded: boolean; evidence?: string; error?: string };
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
    createdBy: string
  ): import('../incidents/store').Awaitable<RemediationPlan>;
  getPlan(planId: string): import('../incidents/store').Awaitable<RemediationPlan | undefined>;
  decide(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string
  ): import('../incidents/store').Awaitable<RemediationPlan | undefined>;
  decideRollback(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string
  ): import('../incidents/store').Awaitable<RemediationPlan | undefined>;
  setExecution(
    planId: string,
    stepId: string,
    status: RemediationStep['status'],
    execution: RemediationStep['executionResult'],
    verification: RemediationStep['verificationResult'] | undefined,
    actor: string
  ): import('../incidents/store').Awaitable<void>;
  setRollback(
    planId: string,
    stepId: string,
    result: RemediationStep['rollbackResult'],
    actor: string
  ): import('../incidents/store').Awaitable<void>;
  beginExecution(
    planId: string,
    stepId: string,
    actor: string
  ): import('../incidents/store').Awaitable<boolean>;
  beginRollback(
    planId: string,
    stepId: string,
    actor: string
  ): import('../incidents/store').Awaitable<boolean>;
  events(planId: string): import('../incidents/store').Awaitable<WorkflowEvent[]>;
  recordEvaluation(
    input: EvaluationCaseInput
  ): import('../incidents/store').Awaitable<EvaluationScore>;
  getEvaluationAnalytics(
    dataset: string
  ): import('../incidents/store').Awaitable<EvaluationAnalytics>;
  listEvaluations(
    dataset: string
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
        created_at TEXT NOT NULL, created_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS remediation_steps (
        id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES remediation_plans(id),
        action_id TEXT NOT NULL, post_check_id TEXT NOT NULL, rollback_action_id TEXT NOT NULL,
        description TEXT NOT NULL, status TEXT NOT NULL, rollback_approved INTEGER NOT NULL DEFAULT 0,
        execution_result TEXT, verification_result TEXT, rollback_result TEXT,
        PRIMARY KEY(plan_id, id)
      );
      CREATE TABLE IF NOT EXISTS remediation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, step_id TEXT,
        action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluation_cases (
        dataset TEXT NOT NULL, case_id TEXT NOT NULL, input_json TEXT NOT NULL, score_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY(dataset, case_id)
      );
    `);
  }
  checkHealth(): void {
    this.db.prepare('SELECT 1').get();
  }

  createPlan(
    incidentId: string,
    title: string,
    steps: RemediationStepInput[],
    createdBy: string
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
        .prepare('INSERT INTO remediation_plans VALUES (?, ?, ?, ?, ?)')
        .run(id, incidentId, plan.title, createdAt, createdBy);
      const insert = this.db.prepare(
        'INSERT INTO remediation_steps (id, plan_id, action_id, post_check_id, rollback_action_id, description, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      for (const step of plan.steps) {
        insert.run(
          step.id,
          id,
          step.actionId,
          step.postCheckId,
          step.rollbackActionId,
          step.description,
          'pending'
        );
        this.addEvent(id, step.id, 'proposed', createdBy, step.description);
      }
    })();
    return plan;
  }

  getPlan(planId: string): RemediationPlan | undefined {
    const plan = this.db.prepare('SELECT * FROM remediation_plans WHERE id=?').get(planId) as
      | PlanRow
      | undefined;
    if (!plan) return undefined;
    const steps = this.db
      .prepare('SELECT * FROM remediation_steps WHERE plan_id=? ORDER BY rowid')
      .all(planId) as StepRow[];
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
    reason: string
  ): RemediationPlan | undefined {
    const step = this.getStep(planId, stepId);
    if (!step) return undefined;
    if (step.status !== 'pending')
      throw new Error('Only pending remediation steps can be approved or rejected');
    if (!reason.trim()) throw new Error('Approval or rejection reason is required');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status=? WHERE plan_id=? AND id=? AND status='pending'"
        )
        .run(status, planId, stepId);
      if (!result.changes)
        throw new Error('Only pending remediation steps can be approved or rejected');
      this.addEvent(
        planId,
        stepId,
        decision === 'approve' ? 'approved' : 'rejected',
        actor,
        reason.trim()
      );
    })();
    return this.getPlan(planId);
  }

  decideRollback(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string
  ): RemediationPlan | undefined {
    const step = this.getStep(planId, stepId);
    if (!step) return undefined;
    if (!['execution_succeeded', 'verified', 'verification_failed'].includes(step.status))
      throw new Error('Rollback approval requires an executed remediation step');
    if (!reason.trim()) throw new Error('Rollback decision reason is required');
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE remediation_steps SET rollback_approved=? WHERE plan_id=? AND id=?')
        .run(decision === 'approve' ? 1 : 0, planId, stepId);
      this.addEvent(
        planId,
        stepId,
        decision === 'approve' ? 'rollback_approved' : 'rollback_rejected',
        actor,
        reason.trim()
      );
    })();
    return this.getPlan(planId);
  }

  setExecution(
    planId: string,
    stepId: string,
    status: RemediationStep['status'],
    execution: RemediationStep['executionResult'],
    verification: RemediationStep['verificationResult'] | undefined,
    actor: string
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE remediation_steps SET status=?, execution_result=?, verification_result=? WHERE plan_id=? AND id=?'
        )
        .run(
          status,
          execution ? JSON.stringify(execution) : null,
          verification ? JSON.stringify(verification) : null,
          planId,
          stepId
        );
      this.addEvent(
        planId,
        stepId,
        status === 'execution_failed' ? 'execution_failed' : 'executed',
        actor,
        execution?.succeeded
          ? 'Registered action reported success'
          : 'Registered action reported failure'
      );
      if (verification)
        this.addEvent(
          planId,
          stepId,
          verification.succeeded ? 'post_check_passed' : 'post_check_failed',
          actor,
          verification.succeeded ? 'Post-action check passed' : 'Post-action check failed'
        );
    })();
  }

  setRollback(
    planId: string,
    stepId: string,
    result: RemediationStep['rollbackResult'],
    actor: string
  ): void {
    const status = result?.succeeded ? 'rolled_back' : 'rollback_failed';
    this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE remediation_steps SET status=?, rollback_result=? WHERE plan_id=? AND id=?'
        )
        .run(status, JSON.stringify(result || {}), planId, stepId);
      this.addEvent(
        planId,
        stepId,
        status,
        actor,
        result?.succeeded
          ? 'Registered rollback action reported success'
          : 'Registered rollback action reported failure'
      );
    })();
  }

  beginExecution(planId: string, stepId: string, actor: string): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status='executing' WHERE plan_id=? AND id=? AND status='approved'"
        )
        .run(planId, stepId);
      if (result.changes)
        this.addEvent(
          planId,
          stepId,
          'execution_started',
          actor,
          'Approved action execution started'
        );
      return result.changes === 1;
    })();
  }

  beginRollback(planId: string, stepId: string, actor: string): boolean {
    return this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE remediation_steps SET status='rolling_back' WHERE plan_id=? AND id=? AND rollback_approved=1 AND status IN ('verified','verification_failed','execution_succeeded')"
        )
        .run(planId, stepId);
      if (result.changes)
        this.addEvent(
          planId,
          stepId,
          'rollback_started',
          actor,
          'Separately approved rollback started'
        );
      return result.changes === 1;
    })();
  }

  events(planId: string): WorkflowEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM remediation_events WHERE plan_id=? ORDER BY id')
        .all(planId) as EventRow[]
    ).map(mapEvent);
  }

  recordEvaluation(input: EvaluationCaseInput): EvaluationScore {
    const score = scoreEvaluationCase(input);
    this.db
      .prepare(
        `INSERT INTO evaluation_cases (dataset, case_id, input_json, score_json, recorded_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(dataset, case_id) DO UPDATE SET input_json=excluded.input_json, score_json=excluded.score_json, recorded_at=excluded.recorded_at`
      )
      .run(
        input.dataset,
        input.caseId,
        JSON.stringify(input),
        JSON.stringify(score),
        new Date().toISOString()
      );
    return score;
  }

  getEvaluationAnalytics(dataset: string): EvaluationAnalytics {
    const rows = this.db
      .prepare('SELECT score_json FROM evaluation_cases WHERE dataset=?')
      .all(dataset) as Array<{ score_json: string }>;
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
    dataset: string
  ): Array<{ caseId: string; recordedAt: string; score: EvaluationScore }> {
    return (
      this.db
        .prepare(
          'SELECT case_id, recorded_at, score_json FROM evaluation_cases WHERE dataset=? ORDER BY case_id'
        )
        .all(dataset) as Array<{ case_id: string; recorded_at: string; score_json: string }>
    ).map((row) => ({
      caseId: row.case_id,
      recordedAt: row.recorded_at,
      score: JSON.parse(row.score_json) as EvaluationScore,
    }));
  }

  close(): void {
    this.db.close();
  }
  private getStep(planId: string, stepId: string): RemediationStep | undefined {
    const row = this.db
      .prepare('SELECT * FROM remediation_steps WHERE plan_id=? AND id=?')
      .get(planId, stepId) as StepRow | undefined;
    return row ? mapStep(row) : undefined;
  }
  private addEvent(
    planId: string,
    stepId: string | null,
    action: string,
    actor: string,
    detail: string
  ): void {
    this.db
      .prepare(
        'INSERT INTO remediation_events (plan_id, step_id, action, actor, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(planId, stepId, action, actor, detail, new Date().toISOString());
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
