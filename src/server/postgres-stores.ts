import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { assertIncidentTransition } from './incidents/store';
import type {
  Incident,
  IncidentEvent,
  IncidentInput,
  IncidentPatch,
  IncidentRepository,
} from './incidents/store';
import type {
  EvaluationAnalytics,
  EvaluationCaseInput,
  EvaluationScore,
  RemediationPlan,
  RemediationStep,
  RemediationStepInput,
  WorkflowEvent,
  WorkflowRepository,
} from './workflows/store';
import { scoreEvaluationCase } from './workflows/store';

/** PostgreSQL schema for durable incident, workflow, evaluation and audit records. */
export async function migratePostgres(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL CHECK (severity IN ('SEV-1','SEV-2','SEV-3','SEV-4')),
      status TEXT NOT NULL CHECK (status IN ('open','investigating','mitigated','resolved')),
      assignee TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_events (
      id BIGSERIAL PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
      action TEXT NOT NULL, detail TEXT NOT NULL, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incident_events_incident_id ON incident_events(incident_id, id);
    CREATE TABLE IF NOT EXISTS remediation_plans (
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remediation_steps (
      id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES remediation_plans(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL, post_check_id TEXT NOT NULL, rollback_action_id TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL, rollback_approved BOOLEAN NOT NULL DEFAULT FALSE,
      execution_result JSONB, verification_result JSONB, rollback_result JSONB,
      PRIMARY KEY(plan_id, id)
    );
    CREATE TABLE IF NOT EXISTS remediation_events (
      id BIGSERIAL PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES remediation_plans(id), step_id TEXT,
      action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS remediation_events_plan_id ON remediation_events(plan_id, id);
    CREATE TABLE IF NOT EXISTS evaluation_cases (
      dataset TEXT NOT NULL, case_id TEXT NOT NULL, input_json JSONB NOT NULL, score_json JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(dataset, case_id)
    );
  `);
}

export class PostgresIncidentStore implements IncidentRepository {
  constructor(private readonly pool: Pool) {}
  async checkHealth(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async list(): Promise<Incident[]> {
    const { rows } = await this.pool.query('SELECT * FROM incidents ORDER BY updated_at DESC');
    return rows.map(mapIncident);
  }
  async get(id: string): Promise<Incident | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM incidents WHERE id=$1', [id]);
    return rows[0] ? mapIncident(rows[0]) : undefined;
  }
  async events(id: string): Promise<IncidentEvent[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY id',
      [id]
    );
    return rows.map(mapIncidentEvent);
  }
  async create(input: IncidentInput, actor = 'system'): Promise<Incident> {
    const now = new Date().toISOString();
    const incident: Incident = {
      id: randomUUID(),
      title: input.title.trim(),
      description: input.description?.trim() || '',
      severity: input.severity,
      status: 'open',
      assignee: input.assignee?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    await transaction(this.pool, async (client) => {
      await client.query('INSERT INTO incidents VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
        incident.id,
        incident.title,
        incident.description,
        incident.severity,
        incident.status,
        incident.assignee,
        now,
        now,
      ]);
      await addIncidentEvent(
        client,
        incident.id,
        'created',
        `Created ${incident.severity} incident`,
        actor,
        now
      );
      if (incident.assignee)
        await addIncidentEvent(
          client,
          incident.id,
          'assignee_changed',
          `Assigned to ${incident.assignee}`,
          actor,
          now
        );
    });
    return incident;
  }
  async update(id: string, patch: IncidentPatch, actor: string): Promise<Incident | undefined> {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query('SELECT * FROM incidents WHERE id=$1 FOR UPDATE', [id]);
      if (!rows[0]) return undefined;
      const current = mapIncident(rows[0]);
      const next = {
        ...current,
        ...patch,
        assignee: patch.assignee === undefined ? current.assignee : patch.assignee?.trim() || null,
      };
      assertIncidentTransition(current.status, next.status);
      const now = new Date().toISOString();
      await client.query(
        'UPDATE incidents SET title=$1,description=$2,severity=$3,status=$4,assignee=$5,updated_at=$6 WHERE id=$7',
        [next.title.trim(), next.description, next.severity, next.status, next.assignee, now, id]
      );
      for (const field of ['title', 'description', 'severity', 'status', 'assignee'] as const)
        if (next[field] !== current[field]) {
          const action =
            field === 'status'
              ? 'status_changed'
              : field === 'assignee'
                ? 'assignee_changed'
                : `${field}_changed`;
          await addIncidentEvent(
            client,
            id,
            action,
            `${field} changed to ${next[field] || '(unassigned)'}`,
            actor,
            now
          );
        }
      const updated = await client.query('SELECT * FROM incidents WHERE id=$1', [id]);
      return mapIncident(updated.rows[0]);
    });
  }
  async close(): Promise<void> {
    /* Pool ownership is shared with WorkflowStore. */
  }
}

export class PostgresWorkflowStore implements WorkflowRepository {
  constructor(private readonly pool: Pool) {}
  async checkHealth(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
  async createPlan(
    incidentId: string,
    title: string,
    steps: RemediationStepInput[],
    createdBy: string
  ): Promise<RemediationPlan> {
    if (!steps.length) throw new Error('A remediation plan must include at least one step');
    const plan: RemediationPlan = {
      id: randomUUID(),
      incidentId,
      title: title.trim(),
      createdAt: new Date().toISOString(),
      createdBy,
      steps: steps.map((s) => ({
        ...s,
        id: randomUUID(),
        status: 'pending',
        rollbackApproved: false,
      })),
    };
    await transaction(this.pool, async (c) => {
      await c.query('INSERT INTO remediation_plans VALUES ($1,$2,$3,$4,$5)', [
        plan.id,
        incidentId,
        plan.title,
        plan.createdAt,
        createdBy,
      ]);
      for (const s of plan.steps) {
        await c.query(
          'INSERT INTO remediation_steps (id,plan_id,action_id,post_check_id,rollback_action_id,description,status) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [s.id, plan.id, s.actionId, s.postCheckId, s.rollbackActionId, s.description, s.status]
        );
        await addWorkflowEvent(c, plan.id, s.id, 'proposed', createdBy, s.description);
      }
    });
    return plan;
  }
  async getPlan(planId: string): Promise<RemediationPlan | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM remediation_plans WHERE id=$1', [planId]);
    if (!rows[0]) return undefined;
    const steps = await this.pool.query(
      'SELECT * FROM remediation_steps WHERE plan_id=$1 ORDER BY id',
      [planId]
    );
    return {
      id: rows[0].id,
      incidentId: rows[0].incident_id,
      title: rows[0].title,
      createdAt: iso(rows[0].created_at),
      createdBy: rows[0].created_by,
      steps: steps.rows.map(mapStep),
    };
  }
  async decide(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string
  ): Promise<RemediationPlan | undefined> {
    if (!reason.trim()) throw new Error('Approval or rejection reason is required');
    const exists = await transaction(this.pool, async (c) => {
      const result = await c.query(
        "UPDATE remediation_steps SET status=$1 WHERE plan_id=$2 AND id=$3 AND status='pending'",
        [decision === 'approve' ? 'approved' : 'rejected', planId, stepId]
      );
      if (!result.rowCount) {
        const step = await c.query('SELECT id FROM remediation_steps WHERE plan_id=$1 AND id=$2', [
          planId,
          stepId,
        ]);
        if (!step.rowCount) return undefined;
        throw new Error('Only pending remediation steps can be approved or rejected');
      }
      await addWorkflowEvent(
        c,
        planId,
        stepId,
        decision === 'approve' ? 'approved' : 'rejected',
        actor,
        reason.trim()
      );
      return true;
    });
    return exists ? this.getPlan(planId) : undefined;
  }
  async decideRollback(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string
  ): Promise<RemediationPlan | undefined> {
    if (!reason.trim()) throw new Error('Rollback decision reason is required');
    const exists = await transaction(this.pool, async (c) => {
      const { rows } = await c.query(
        'SELECT status FROM remediation_steps WHERE plan_id=$1 AND id=$2 FOR UPDATE',
        [planId, stepId]
      );
      if (!rows[0]) return undefined;
      if (!['execution_succeeded', 'verified', 'verification_failed'].includes(rows[0].status))
        throw new Error('Rollback approval requires an executed remediation step');
      await c.query(
        'UPDATE remediation_steps SET rollback_approved=$1 WHERE plan_id=$2 AND id=$3',
        [decision === 'approve', planId, stepId]
      );
      await addWorkflowEvent(
        c,
        planId,
        stepId,
        decision === 'approve' ? 'rollback_approved' : 'rollback_rejected',
        actor,
        reason.trim()
      );
      return true;
    });
    return exists ? this.getPlan(planId) : undefined;
  }
  async setExecution(
    planId: string,
    stepId: string,
    status: RemediationStep['status'],
    execution: RemediationStep['executionResult'],
    verification: RemediationStep['verificationResult'] | undefined,
    actor: string
  ): Promise<void> {
    await transaction(this.pool, async (c) => {
      await c.query(
        'UPDATE remediation_steps SET status=$1,execution_result=$2::jsonb,verification_result=$3::jsonb WHERE plan_id=$4 AND id=$5',
        [
          status,
          execution ? JSON.stringify(execution) : null,
          verification ? JSON.stringify(verification) : null,
          planId,
          stepId,
        ]
      );
      await addWorkflowEvent(
        c,
        planId,
        stepId,
        status === 'execution_failed' ? status : 'executed',
        actor,
        execution?.succeeded
          ? 'Registered action reported success'
          : 'Registered action reported failure'
      );
      if (verification)
        await addWorkflowEvent(
          c,
          planId,
          stepId,
          verification.succeeded ? 'post_check_passed' : 'post_check_failed',
          actor,
          verification.succeeded ? 'Post-action check passed' : 'Post-action check failed'
        );
    });
  }
  async setRollback(
    planId: string,
    stepId: string,
    result: RemediationStep['rollbackResult'],
    actor: string
  ): Promise<void> {
    const status = result?.succeeded ? 'rolled_back' : 'rollback_failed';
    await transaction(this.pool, async (c) => {
      await c.query(
        'UPDATE remediation_steps SET status=$1,rollback_result=$2::jsonb WHERE plan_id=$3 AND id=$4',
        [status, JSON.stringify(result || {}), planId, stepId]
      );
      await addWorkflowEvent(
        c,
        planId,
        stepId,
        status,
        actor,
        result?.succeeded
          ? 'Registered rollback action reported success'
          : 'Registered rollback action reported failure'
      );
    });
  }
  async beginExecution(planId: string, stepId: string, actor: string): Promise<boolean> {
    return transaction(this.pool, async (c) => {
      const result = await c.query(
        "UPDATE remediation_steps SET status='executing' WHERE plan_id=$1 AND id=$2 AND status='approved'",
        [planId, stepId]
      );
      if (result.rowCount)
        await addWorkflowEvent(
          c,
          planId,
          stepId,
          'execution_started',
          actor,
          'Approved action execution started'
        );
      return result.rowCount === 1;
    });
  }
  async beginRollback(planId: string, stepId: string, actor: string): Promise<boolean> {
    return transaction(this.pool, async (c) => {
      const result = await c.query(
        "UPDATE remediation_steps SET status='rolling_back' WHERE plan_id=$1 AND id=$2 AND rollback_approved=TRUE AND status IN ('verified','verification_failed','execution_succeeded')",
        [planId, stepId]
      );
      if (result.rowCount)
        await addWorkflowEvent(
          c,
          planId,
          stepId,
          'rollback_started',
          actor,
          'Separately approved rollback started'
        );
      return result.rowCount === 1;
    });
  }
  async events(planId: string): Promise<WorkflowEvent[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM remediation_events WHERE plan_id=$1 ORDER BY id',
      [planId]
    );
    return rows.map((r) => ({
      id: Number(r.id),
      planId: r.plan_id,
      stepId: r.step_id,
      action: r.action,
      actor: r.actor,
      detail: r.detail,
      createdAt: iso(r.created_at),
    }));
  }
  async recordEvaluation(input: EvaluationCaseInput): Promise<EvaluationScore> {
    const score = scoreEvaluationCase(input);
    await this.pool.query(
      `INSERT INTO evaluation_cases(dataset,case_id,input_json,score_json,recorded_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT(dataset,case_id) DO UPDATE SET input_json=EXCLUDED.input_json,score_json=EXCLUDED.score_json,recorded_at=EXCLUDED.recorded_at`,
      [
        input.dataset,
        input.caseId,
        JSON.stringify(input),
        JSON.stringify(score),
        new Date().toISOString(),
      ]
    );
    return score;
  }
  async getEvaluationAnalytics(dataset: string): Promise<EvaluationAnalytics> {
    const { rows } = await this.pool.query(
      'SELECT score_json FROM evaluation_cases WHERE dataset=$1',
      [dataset]
    );
    const scores = rows.map(
      (r) =>
        (typeof r.score_json === 'string'
          ? JSON.parse(r.score_json)
          : r.score_json) as EvaluationScore
    );
    const fields = [
      'rootCauseCorrect',
      'evidencePrecision',
      'evidenceRecall',
      'retrievalQuality',
      'fixOutcomeCorrect',
    ] as const;
    const aggregate = (key: 'baseline' | 'graph') => {
      const mean = (field: (typeof fields)[number]) =>
        scores.length ? scores.reduce((n, s) => n + Number(s[key][field]), 0) / scores.length : 0;
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
      cases: scores.length,
      baseline: aggregate('baseline'),
      graph: aggregate('graph'),
    };
  }
  async listEvaluations(
    dataset: string
  ): Promise<Array<{ caseId: string; recordedAt: string; score: EvaluationScore }>> {
    const { rows } = await this.pool.query(
      'SELECT case_id,recorded_at,score_json FROM evaluation_cases WHERE dataset=$1 ORDER BY case_id',
      [dataset]
    );
    return rows.map((r) => ({
      caseId: r.case_id,
      recordedAt: iso(r.recorded_at),
      score: (typeof r.score_json === 'string'
        ? JSON.parse(r.score_json)
        : r.score_json) as EvaluationScore,
    }));
  }
  async close(): Promise<void> {
    /* Pool ownership is shared with IncidentStore. */
  }
}

export async function createPostgresStores(connectionString: string) {
  const pool = new Pool({ connectionString, max: 10, application_name: 'tracemind-api' });
  pool.on('error', (error) => console.error('PostgreSQL pool error', error));
  try {
    await migratePostgres(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    pool,
    incidentStore: new PostgresIncidentStore(pool),
    workflowStore: new PostgresWorkflowStore(pool),
    close: () => pool.end(),
  };
}

async function transaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function addIncidentEvent(
  c: PoolClient,
  id: string,
  action: string,
  detail: string,
  actor: string,
  at: string
) {
  await c.query(
    'INSERT INTO incident_events(incident_id,action,detail,actor,created_at) VALUES($1,$2,$3,$4,$5)',
    [id, action, detail, actor, at]
  );
}
async function addWorkflowEvent(
  c: PoolClient,
  planId: string,
  stepId: string | null,
  action: string,
  actor: string,
  detail: string
) {
  await c.query(
    'INSERT INTO remediation_events(plan_id,step_id,action,actor,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)',
    [planId, stepId, action, actor, detail, new Date().toISOString()]
  );
}
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
type IncidentPgRow = {
  id: string;
  title: string;
  description: string;
  severity: Incident['severity'];
  status: Incident['status'];
  assignee: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};
type IncidentEventPgRow = {
  id: string | number;
  incident_id: string;
  action: string;
  detail: string;
  actor: string;
  created_at: Date | string;
};
type StepPgRow = {
  id: string;
  action_id: string;
  post_check_id: string;
  rollback_action_id: string;
  description: string;
  status: RemediationStep['status'];
  rollback_approved: boolean;
  execution_result: unknown | null;
  verification_result: unknown | null;
  rollback_result: unknown | null;
};
function mapIncident(r: IncidentPgRow): Incident {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
    assignee: r.assignee,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
function mapIncidentEvent(r: IncidentEventPgRow): IncidentEvent {
  return {
    id: Number(r.id),
    incidentId: r.incident_id,
    action: r.action,
    detail: r.detail,
    actor: r.actor,
    createdAt: iso(r.created_at),
  };
}
function mapStep(r: StepPgRow): RemediationStep {
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    id: r.id,
    actionId: r.action_id,
    postCheckId: r.post_check_id,
    rollbackActionId: r.rollback_action_id,
    description: r.description,
    status: r.status,
    rollbackApproved: r.rollback_approved === true,
    ...(r.execution_result ? { executionResult: json(r.execution_result) } : {}),
    ...(r.verification_result ? { verificationResult: json(r.verification_result) } : {}),
    ...(r.rollback_result ? { rollbackResult: json(r.rollback_result) } : {}),
  };
}
