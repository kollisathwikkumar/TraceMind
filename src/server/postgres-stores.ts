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
import { grantRuntimeTenantTables, queryForTenant, transactionForTenant } from './postgres-tenant-context';

/** PostgreSQL schema for durable incident, workflow, evaluation and audit records. */
export async function migratePostgres(pool: Pool, runtimeRole?: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [905141]);
    await client.query('BEGIN');
    await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      severity TEXT NOT NULL CHECK (severity IN ('SEV-1','SEV-2','SEV-3','SEV-4')),
      status TEXT NOT NULL CHECK (status IN ('open','investigating','mitigated','resolved')),
      assignee TEXT, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE IF NOT EXISTS incident_events (
      id BIGSERIAL PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id),
      action TEXT NOT NULL, detail TEXT NOT NULL, actor TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE INDEX IF NOT EXISTS incident_events_incident_id ON incident_events(incident_id, id);
    CREATE TABLE IF NOT EXISTS remediation_plans (
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, created_by TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE TABLE IF NOT EXISTS remediation_steps (
      id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES remediation_plans(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL, post_check_id TEXT NOT NULL, rollback_action_id TEXT NOT NULL,
      description TEXT NOT NULL, status TEXT NOT NULL, rollback_approved BOOLEAN NOT NULL DEFAULT FALSE,
      approved_by TEXT, rollback_approved_by TEXT, executed_by TEXT, lease_token TEXT, lease_expires_at TIMESTAMPTZ,
      execution_result JSONB, verification_result JSONB, verification_reconciled_by TEXT, rollback_result JSONB,
      tenant_id TEXT NOT NULL DEFAULT 'default', PRIMARY KEY(plan_id, id)
    );
    CREATE TABLE IF NOT EXISTS remediation_events (
      id BIGSERIAL PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES remediation_plans(id), step_id TEXT,
      action TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default'
    );
    CREATE INDEX IF NOT EXISTS remediation_events_plan_id ON remediation_events(plan_id, id);
    CREATE TABLE IF NOT EXISTS evaluation_cases (
      dataset TEXT NOT NULL, case_id TEXT NOT NULL, input_json JSONB NOT NULL, score_json JSONB NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY(tenant_id, dataset, case_id)
    );
    CREATE TABLE IF NOT EXISTS graph_projection_outbox (
      id BIGSERIAL PRIMARY KEY, org_id TEXT NOT NULL, event_type TEXT NOT NULL,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_until TIMESTAMPTZ, lease_token TEXT, processed_at TIMESTAMPTZ, last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS graph_projection_outbox_ready
      ON graph_projection_outbox(available_at, id) WHERE processed_at IS NULL;
  `);
    await client.query(`
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE incident_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE remediation_plans ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE remediation_events ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE graph_projection_outbox ADD COLUMN IF NOT EXISTS lease_token TEXT;
      ALTER TABLE evaluation_cases ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'default';
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS approved_by TEXT;
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS rollback_approved_by TEXT;
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS verification_reconciled_by TEXT;
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS executed_by TEXT;
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS lease_token TEXT;
      ALTER TABLE remediation_steps ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
    `);
    await grantRuntimeTenantTables(client, runtimeRole, [
      'schema_migrations','incidents','incident_events','remediation_plans','remediation_steps',
      'remediation_events','evaluation_cases','graph_projection_outbox',
    ]);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS incidents_tenant_id_key ON incidents(tenant_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS remediation_plans_tenant_id_key ON remediation_plans(tenant_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS remediation_steps_tenant_id_key ON remediation_steps(tenant_id,plan_id,id);
      CREATE INDEX IF NOT EXISTS incidents_tenant_updated_idx ON incidents(tenant_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS incident_events_tenant_idx ON incident_events(tenant_id,incident_id,id);
      CREATE INDEX IF NOT EXISTS remediation_events_tenant_idx ON remediation_events(tenant_id,plan_id,id);
      CREATE INDEX IF NOT EXISTS evaluation_cases_tenant_idx ON evaluation_cases(tenant_id,dataset,case_id);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='incident_events_tenant_fk') THEN
          ALTER TABLE incident_events ADD CONSTRAINT incident_events_tenant_fk
            FOREIGN KEY(tenant_id,incident_id) REFERENCES incidents(tenant_id,id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='remediation_plans_tenant_incident_fk') THEN
          ALTER TABLE remediation_plans ADD CONSTRAINT remediation_plans_tenant_incident_fk
            FOREIGN KEY(tenant_id,incident_id) REFERENCES incidents(tenant_id,id);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='remediation_steps_tenant_plan_fk') THEN
          ALTER TABLE remediation_steps ADD CONSTRAINT remediation_steps_tenant_plan_fk
            FOREIGN KEY(tenant_id,plan_id) REFERENCES remediation_plans(tenant_id,id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='remediation_events_tenant_plan_fk') THEN
          ALTER TABLE remediation_events ADD CONSTRAINT remediation_events_tenant_plan_fk
            FOREIGN KEY(tenant_id,plan_id) REFERENCES remediation_plans(tenant_id,id);
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ DECLARE primary_name TEXT; BEGIN
        SELECT conname INTO primary_name FROM pg_constraint
        WHERE conrelid='evaluation_cases'::regclass AND contype='p';
        IF primary_name IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
          WHERE c.conrelid='evaluation_cases'::regclass AND c.contype='p' AND a.attname='tenant_id'
        ) THEN
          EXECUTE format('ALTER TABLE evaluation_cases DROP CONSTRAINT %I', primary_name);
          ALTER TABLE evaluation_cases ADD PRIMARY KEY(tenant_id,dataset,case_id);
        END IF;
      END $$;
    `);
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',
      [1]
    );
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',
      [2]
    );
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',
      [3]
    );
    await client.query(
      'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',
      [4]
    );
    await client.query('GRANT SELECT ON schema_migrations TO PUBLIC');
    await client.query(`
      DO $$ DECLARE tbl TEXT; BEGIN
        FOREACH tbl IN ARRAY ARRAY['incidents','incident_events','remediation_plans','remediation_steps','remediation_events','evaluation_cases'] LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
          EXECUTE format('DROP POLICY IF EXISTS tracemind_tenant_isolation ON %I', tbl);
          EXECUTE format('CREATE POLICY tracemind_tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', tbl);
        END LOOP;
        ALTER TABLE graph_projection_outbox ENABLE ROW LEVEL SECURITY;
        ALTER TABLE graph_projection_outbox FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tracemind_tenant_isolation ON graph_projection_outbox;
        CREATE POLICY tracemind_tenant_isolation ON graph_projection_outbox
          USING (org_id = current_setting('app.tenant_id', true))
          WITH CHECK (org_id = current_setting('app.tenant_id', true));
      END $$;
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [905141]).catch(() => undefined);
    client.release();
  }
}

export type GraphProjectionEvent =
  | { type: 'service.upsert'; orgId: string; data: { id: string; name: string; serviceType?: string; owner?: string } }
  | { type: 'dependency.link'; orgId: string; data: { dependentId: string; dependencyId: string; criticality?: 'critical' | 'degraded' | 'optional' } };

/** Durable PostgreSQL event log for replayable FalkorDB projection writes. */
export class PostgresGraphOutbox {
  constructor(private readonly pool: Pool) {}

  async checkHealth(orgId: string): Promise<number> {
    const result = await queryForTenant<{ pending: string | number }>(this.pool, orgId,
      'SELECT count(*) AS pending FROM graph_projection_outbox WHERE org_id=$1 AND processed_at IS NULL',
      [orgId]
    );
    return Number(result.rows[0]?.pending || 0);
  }

  async enqueue(event: GraphProjectionEvent): Promise<string> {
    const result = await queryForTenant<{ id: string }>(this.pool, event.orgId,
      'INSERT INTO graph_projection_outbox(org_id,event_type,payload) VALUES($1,$2,$3) RETURNING id',
      [event.orgId, event.type, event.data]
    );
    return result.rows[0].id;
  }

  async replay(graph: {
    upsertService(input: { orgId: string; id: string; name: string; serviceType?: string; owner?: string }): Promise<void>;
    linkDependency(input: { orgId: string; dependentId: string; dependencyId: string; criticality?: 'critical' | 'degraded' | 'optional' }): Promise<void>;
  }, orgId: string, limit = 50): Promise<{ processed: number; failed: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Outbox replay limit must be 1..500');
    let processed = 0;
    let failed = 0;
    for (let i = 0; i < limit; i++) {
      const item = await transaction(this.pool, orgId, async (client) => {
        const claimed = await client.query<{ id: string; org_id: string; event_type: string; payload: Record<string, unknown> }>(
          `SELECT id,org_id,event_type,payload FROM graph_projection_outbox
           WHERE org_id=$1 AND processed_at IS NULL AND available_at <= NOW()
             AND (lease_until IS NULL OR lease_until < NOW())
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`, [orgId]
        );
        const row = claimed.rows[0];
        if (!row) return undefined;
        const leaseToken = randomUUID();
        await client.query('UPDATE graph_projection_outbox SET lease_until=NOW()+INTERVAL \'60 seconds\', lease_token=$3, attempts=attempts+1 WHERE id=$1 AND org_id=$2', [row.id, orgId, leaseToken]);
        return { ...row, lease_token: leaseToken };
      });
      if (!item) break;
      try {
        const payload = item.payload as Record<string, unknown>;
        if (item.event_type === 'service.upsert') {
          await graph.upsertService({ ...(payload as { id: string; name: string; serviceType?: string; owner?: string }), orgId: item.org_id });
        } else if (item.event_type === 'dependency.link') {
          await graph.linkDependency({ ...(payload as { dependentId: string; dependencyId: string; criticality?: 'critical' | 'degraded' | 'optional' }), orgId: item.org_id });
        } else {
          throw new Error(`Unknown outbox event type: ${item.event_type}`);
        }
        const completed = await queryForTenant(this.pool, orgId, 'UPDATE graph_projection_outbox SET processed_at=NOW(), lease_until=NULL, lease_token=NULL, last_error=NULL WHERE id=$1 AND org_id=$2 AND lease_token=$3 AND processed_at IS NULL', [item.id, orgId, item.lease_token]);
        if (completed.rowCount) processed++;
      } catch (error) {
        const released = await queryForTenant(this.pool, orgId,
          `UPDATE graph_projection_outbox SET lease_until=NULL, lease_token=NULL, available_at=NOW()+LEAST(INTERVAL '5 minutes', INTERVAL '2 seconds' * POWER(2, LEAST(attempts,7))), last_error=$2 WHERE id=$1 AND org_id=$3 AND lease_token=$4 AND processed_at IS NULL`,
          [item.id, error instanceof Error ? error.message.slice(0, 1000) : 'Projection failed', orgId, item.lease_token]
        );
        if (released.rowCount) failed++;
      }
    }
    return { processed, failed };
  }
}

export class PostgresIncidentStore implements IncidentRepository {
  constructor(private readonly pool: Pool) {}
  async checkHealth(): Promise<void> {
    await checkPostgresSchema(this.pool);
  }
  async list(tenantId = 'default'): Promise<Incident[]> {
    const { rows } = await queryForTenant<IncidentPgRow>(this.pool, tenantId, 'SELECT * FROM incidents WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId]);
    return rows.map(mapIncident);
  }
  async get(id: string, tenantId = 'default'): Promise<Incident | undefined> {
    const { rows } = await queryForTenant<IncidentPgRow>(this.pool, tenantId, 'SELECT * FROM incidents WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
    return rows[0] ? mapIncident(rows[0]) : undefined;
  }
  async events(id: string, tenantId = 'default'): Promise<IncidentEvent[]> {
    const { rows } = await queryForTenant<IncidentEventPgRow>(this.pool, tenantId,
      'SELECT * FROM incident_events WHERE incident_id=$1 AND tenant_id=$2 ORDER BY id',
      [id, tenantId]
    );
    return rows.map(mapIncidentEvent);
  }
  async create(input: IncidentInput, actor = 'system', tenantId = 'default'): Promise<Incident> {
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
    await transaction(this.pool, tenantId, async (client) => {
      await client.query('INSERT INTO incidents (id,title,description,severity,status,assignee,created_at,updated_at,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
        incident.id,
        incident.title,
        incident.description,
        incident.severity,
        incident.status,
        incident.assignee,
        now,
        now,
        tenantId,
      ]);
      await addIncidentEvent(
        client,
        incident.id,
        'created',
        `Created ${incident.severity} incident`,
        actor,
        now,
        tenantId
      );
      if (incident.assignee)
        await addIncidentEvent(
          client,
          incident.id,
          'assignee_changed',
          `Assigned to ${incident.assignee}`,
          actor,
          now,
          tenantId
        );
    });
    return incident;
  }
  async update(id: string, patch: IncidentPatch, actor: string, tenantId = 'default'): Promise<Incident | undefined> {
    return transaction(this.pool, tenantId, async (client) => {
      const { rows } = await client.query('SELECT * FROM incidents WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id, tenantId]);
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
        'UPDATE incidents SET title=$1,description=$2,severity=$3,status=$4,assignee=$5,updated_at=$6 WHERE id=$7 AND tenant_id=$8',
        [next.title.trim(), next.description, next.severity, next.status, next.assignee, now, id, tenantId]
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
            now,
            tenantId
          );
        }
      const updated = await client.query('SELECT * FROM incidents WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
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
    await checkPostgresSchema(this.pool);
  }
  async createPlan(
    incidentId: string,
    title: string,
    steps: RemediationStepInput[],
    createdBy: string,
    tenantId = 'default'
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
    await transaction(this.pool, tenantId, async (c) => {
      await c.query('INSERT INTO remediation_plans (id,incident_id,title,created_at,created_by,tenant_id) VALUES ($1,$2,$3,$4,$5,$6)', [
        plan.id,
        incidentId,
        plan.title,
        plan.createdAt,
        createdBy,
        tenantId,
      ]);
      for (const s of plan.steps) {
        await c.query(
          'INSERT INTO remediation_steps (id,plan_id,action_id,post_check_id,rollback_action_id,description,status,tenant_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [s.id, plan.id, s.actionId, s.postCheckId, s.rollbackActionId, s.description, s.status, tenantId]
        );
        await addWorkflowEvent(c, plan.id, s.id, 'proposed', createdBy, s.description, tenantId);
      }
    });
    return plan;
  }
  async getPlan(planId: string, tenantId = 'default'): Promise<RemediationPlan | undefined> {
    const { rows } = await queryForTenant<PlanPgRow>(this.pool, tenantId, 'SELECT * FROM remediation_plans WHERE id=$1 AND tenant_id=$2', [planId, tenantId]);
    if (!rows[0]) return undefined;
    const steps = await queryForTenant<StepPgRow>(this.pool, tenantId,
      'SELECT * FROM remediation_steps WHERE plan_id=$1 AND tenant_id=$2 ORDER BY id',
      [planId, tenantId]
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
    reason: string,
    tenantId = 'default'
  ): Promise<RemediationPlan | undefined> {
    if (!reason.trim()) throw new Error('Approval or rejection reason is required');
    const exists = await transaction(this.pool, tenantId, async (c) => {
      const current = await c.query(
        'SELECT p.created_by,s.status FROM remediation_plans p JOIN remediation_steps s ON s.plan_id=p.id AND s.tenant_id=p.tenant_id WHERE p.id=$1 AND p.tenant_id=$3 AND s.id=$2 AND s.tenant_id=$3 FOR UPDATE OF s',
        [planId, stepId, tenantId]
      );
      if (!current.rows[0]) return undefined;
      if (decision === 'approve' && current.rows[0].created_by === actor) {
        throw new Error('Remediation proposer cannot approve their own plan');
      }
      const result = await c.query(
        "UPDATE remediation_steps SET status=$1,approved_by=$2 WHERE plan_id=$3 AND id=$4 AND tenant_id=$5 AND status='pending'",
        [decision === 'approve' ? 'approved' : 'rejected', decision === 'approve' ? actor : null, planId, stepId, tenantId]
      );
      if (!result.rowCount) {
        const step = await c.query('SELECT id FROM remediation_steps WHERE plan_id=$1 AND id=$2 AND tenant_id=$3', [
          planId,
          stepId,
          tenantId,
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
        reason.trim(),
        tenantId
      );
      return true;
    });
    return exists ? this.getPlan(planId, tenantId) : undefined;
  }
  async decideRollback(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    actor: string,
    reason: string,
    tenantId = 'default'
  ): Promise<RemediationPlan | undefined> {
    if (!reason.trim()) throw new Error('Rollback decision reason is required');
    const exists = await transaction(this.pool, tenantId, async (c) => {
      const { rows } = await c.query(
        'SELECT s.status,s.approved_by,s.executed_by,s.verification_reconciled_by,p.created_by FROM remediation_steps s JOIN remediation_plans p ON p.id=s.plan_id AND p.tenant_id=s.tenant_id WHERE s.plan_id=$1 AND s.id=$2 AND s.tenant_id=$3 FOR UPDATE OF s',
        [planId, stepId, tenantId]
      );
      if (!rows[0]) return undefined;
      if (decision === 'approve' && (rows[0].created_by === actor || rows[0].approved_by === actor || rows[0].executed_by === actor || rows[0].verification_reconciled_by === actor)) {
        throw new Error('Rollback proposer, approver, executor, and verification reconciler must be different');
      }
      if (!['execution_succeeded', 'verified', 'verification_failed'].includes(rows[0].status))
        throw new Error('Rollback approval requires an executed remediation step');
      await c.query(
        'UPDATE remediation_steps SET rollback_approved=$1,rollback_approved_by=$2 WHERE plan_id=$3 AND id=$4 AND tenant_id=$5',
        [decision === 'approve', decision === 'approve' ? actor : null, planId, stepId, tenantId]
      );
      await addWorkflowEvent(
        c,
        planId,
        stepId,
        decision === 'approve' ? 'rollback_approved' : 'rollback_rejected',
        actor,
        reason.trim(),
        tenantId
      );
      return true;
    });
    return exists ? this.getPlan(planId, tenantId) : undefined;
  }
  async setExecution(
    planId: string,
    stepId: string,
    status: RemediationStep['status'],
    execution: RemediationStep['executionResult'],
    verification: RemediationStep['verificationResult'] | undefined,
    actor: string,
    leaseToken: string,
    tenantId = 'default'
  ): Promise<boolean> {
    return transaction(this.pool, tenantId, async (c) => {
      const result = await c.query(
        "UPDATE remediation_steps SET status=$1,execution_result=$2::jsonb,verification_result=$3::jsonb,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=$4 AND id=$5 AND tenant_id=$6 AND status='executing' AND lease_token=$7",
        [
          status,
          execution ? JSON.stringify(execution) : null,
          verification ? JSON.stringify(verification) : null,
          planId,
          stepId,
          tenantId,
          leaseToken,
        ]
      );
      if (!result.rowCount) return false;
      await addWorkflowEvent(
        c,
        planId,
        stepId,
        status === 'execution_failed' ? status : 'executed',
        actor,
          execution?.succeeded
          ? 'Registered action reported success'
            : 'Registered action reported failure',
          tenantId
      );
      if (verification)
        await addWorkflowEvent(
          c,
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
    });
  }
  async resolveUnknown(
    planId: string,
    stepId: string,
    operation: 'execute' | 'verify' | 'rollback',
    succeeded: boolean,
    evidence: string,
    actor: string,
    tenantId = 'default'
  ): Promise<boolean> {
    const trimmedEvidence = evidence.trim().slice(0, 4000);
    if (!trimmedEvidence) throw new Error('Reconciliation evidence is required');
    return transaction(this.pool, tenantId, async (c) => {
      const roles = await c.query<{ created_by: string; approved_by: string | null; rollback_approved_by: string | null; executed_by: string | null; rollback_executor: string | null }>(
        `SELECT p.created_by,s.approved_by,s.rollback_approved_by,s.executed_by,
          (SELECT actor FROM remediation_events e WHERE e.plan_id=s.plan_id AND e.step_id=s.id
            AND e.action='rollback_started' AND e.tenant_id=s.tenant_id ORDER BY e.id DESC LIMIT 1) AS rollback_executor
         FROM remediation_steps s JOIN remediation_plans p ON p.id=s.plan_id AND p.tenant_id=s.tenant_id
         WHERE s.plan_id=$1 AND s.id=$2 AND s.tenant_id=$3 FOR UPDATE OF s`,
        [planId, stepId, tenantId]
      );
      const role = roles.rows[0];
      if (!role || [role.created_by, role.approved_by, role.rollback_approved_by, role.executed_by, role.rollback_executor].includes(actor)) return false;
      const status = operation === 'execute'
        ? (succeeded ? 'execution_succeeded' : 'execution_failed')
        : operation === 'verify'
          ? (succeeded ? 'verified' : 'verification_failed')
          : (succeeded ? 'rolled_back' : 'rollback_failed');
      const resultColumn = operation === 'execute' ? 'execution_result' : operation === 'verify' ? 'verification_result' : 'rollback_result';
      const unknownStatus = operation === 'execute' ? 'execution_unknown' : operation === 'verify' ? 'verification_unknown' : 'rollback_unknown';
      const result = operation === 'verify'
        ? await c.query(
          `UPDATE remediation_steps SET status=$1,verification_result=$2::jsonb,verification_reconciled_by=$3,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=$4 AND id=$5 AND tenant_id=$6 AND status=$7`,
          [status, JSON.stringify({ succeeded, evidence: trimmedEvidence }), actor, planId, stepId, tenantId, unknownStatus]
        )
        : await c.query(
          `UPDATE remediation_steps SET status=$1,${resultColumn}=$2::jsonb,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=$3 AND id=$4 AND tenant_id=$5 AND status=$6`,
          [status, JSON.stringify({ succeeded, output: `Operator reconciliation: ${trimmedEvidence}` }), planId, stepId, tenantId, unknownStatus]
        );
      if (!result.rowCount) return false;
      await addWorkflowEvent(c, planId, stepId, `${operation}_reconciled`, actor, `${operation} outcome recorded as ${succeeded ? 'succeeded' : 'failed'}; evidence: ${trimmedEvidence}`, tenantId);
      return true;
    });
  }
  async setRollback(
    planId: string,
    stepId: string,
    result: RemediationStep['rollbackResult'],
    actor: string,
    leaseToken: string,
    tenantId = 'default',
    outcomeUnknown = false
  ): Promise<boolean> {
    const status = outcomeUnknown ? 'rollback_unknown' : result?.succeeded ? 'rolled_back' : 'rollback_failed';
    return transaction(this.pool, tenantId, async (c) => {
      const update = await c.query(
        "UPDATE remediation_steps SET status=$1,rollback_result=$2::jsonb,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=$3 AND id=$4 AND tenant_id=$5 AND status='rolling_back' AND lease_token=$6",
        [status, JSON.stringify(result || {}), planId, stepId, tenantId, leaseToken]
      );
      if (!update.rowCount) return false;
      await addWorkflowEvent(
        c,
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
    });
  }
  async beginExecution(planId: string, stepId: string, actor: string, leaseToken: string, tenantId = 'default'): Promise<boolean> {
    return transaction(this.pool, tenantId, async (c) => {
      const roles = await c.query(
        'SELECT p.created_by,s.approved_by FROM remediation_plans p JOIN remediation_steps s ON s.plan_id=p.id AND s.tenant_id=p.tenant_id WHERE p.id=$1 AND s.id=$2 AND p.tenant_id=$3',
        [planId, stepId, tenantId]
      );
      if (roles.rows[0]?.created_by === actor)
        throw new Error('Remediation proposer cannot execute the plan');
      if (roles.rows[0]?.approved_by === actor)
        throw new Error('Remediation approver and executor must be different');
      const result = await c.query(
        "UPDATE remediation_steps SET status='executing',executed_by=$3,lease_token=$4,lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE plan_id=$1 AND id=$2 AND tenant_id=$5 AND status='approved' AND approved_by<>$3 AND EXISTS (SELECT 1 FROM remediation_plans WHERE id=$1 AND tenant_id=$5 AND created_by<>$3)",
        [planId, stepId, actor, leaseToken, tenantId]
      );
      if (result.rowCount)
        await addWorkflowEvent(
          c,
          planId,
          stepId,
          'execution_started',
          actor,
          'Approved action execution started',
          tenantId
        );
      return result.rowCount === 1;
    });
  }
  async beginRollback(planId: string, stepId: string, actor: string, leaseToken: string, tenantId = 'default'): Promise<boolean> {
    return transaction(this.pool, tenantId, async (c) => {
      const roles = await c.query(
        'SELECT p.created_by,s.approved_by,s.rollback_approved_by,s.executed_by,s.verification_reconciled_by FROM remediation_steps s JOIN remediation_plans p ON p.id=s.plan_id AND p.tenant_id=s.tenant_id WHERE s.plan_id=$1 AND s.id=$2 AND s.tenant_id=$3 FOR UPDATE OF s',
        [planId, stepId, tenantId]
      );
      const role = roles.rows[0];
      if (!role || !role.rollback_approved_by || role.rollback_approved_by === role.verification_reconciled_by || role.created_by === actor || role.approved_by === actor || role.rollback_approved_by === actor || role.executed_by === actor || role.verification_reconciled_by === actor) return false;
      const result = await c.query(
        "UPDATE remediation_steps SET status='rolling_back',lease_token=$3,lease_expires_at=NOW()+INTERVAL '60 seconds' WHERE plan_id=$1 AND id=$2 AND tenant_id=$4 AND rollback_approved=TRUE AND rollback_approved_by IS NOT NULL AND (verification_reconciled_by IS NULL OR verification_reconciled_by<>rollback_approved_by) AND (verification_reconciled_by IS NULL OR verification_reconciled_by<>$5) AND status IN ('verified','verification_failed','execution_succeeded')",
        [planId, stepId, leaseToken, tenantId, actor]
      );
      if (result.rowCount)
        await addWorkflowEvent(
          c,
          planId,
          stepId,
          'rollback_started',
          actor,
          'Separately approved rollback started',
          tenantId
        );
      return result.rowCount === 1;
    });
  }
  async reconcileExpiredLeases(actor: string, now = new Date(), tenantId?: string): Promise<number> {
    if (!tenantId) throw new Error('Tenant ID is required to reconcile leases safely');
    return transaction(this.pool, tenantId, async (c) => {
      const expired = await c.query(
        "SELECT plan_id,id,status,tenant_id FROM remediation_steps WHERE ($2::text IS NULL OR tenant_id=$2) AND status IN ('executing','rolling_back') AND lease_expires_at < $1 FOR UPDATE SKIP LOCKED",
        [now.toISOString(), tenantId ?? null]
      );
      for (const row of expired.rows) {
        const status = row.status === 'executing' ? 'execution_unknown' : 'rollback_unknown';
        await c.query(
          'UPDATE remediation_steps SET status=$1,lease_token=NULL,lease_expires_at=NULL WHERE plan_id=$2 AND id=$3 AND tenant_id=$4',
          [status, row.plan_id, row.id, row.tenant_id]
        );
        await addWorkflowEvent(
          c,
          row.plan_id,
          row.id,
          'lease_expired',
          actor,
          `In-flight ${row.status} attempt expired; outcome requires reconciliation`,
          row.tenant_id
        );
      }
      return expired.rowCount || 0;
    });
  }
  async events(planId: string, tenantId = 'default'): Promise<WorkflowEvent[]> {
    const { rows } = await queryForTenant(this.pool, tenantId,
      'SELECT * FROM remediation_events WHERE plan_id=$1 AND tenant_id=$2 ORDER BY id',
      [planId, tenantId]
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
  async recordEvaluation(input: EvaluationCaseInput, tenantId = 'default'): Promise<EvaluationScore> {
    const score = scoreEvaluationCase(input);
    await queryForTenant(this.pool, tenantId,
      `INSERT INTO evaluation_cases(dataset,case_id,input_json,score_json,recorded_at,tenant_id) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6) ON CONFLICT(tenant_id,dataset,case_id) DO UPDATE SET input_json=EXCLUDED.input_json,score_json=EXCLUDED.score_json,recorded_at=EXCLUDED.recorded_at`,
      [
        input.dataset,
        input.caseId,
        JSON.stringify(input),
        JSON.stringify(score),
        new Date().toISOString(),
        tenantId,
      ]
    );
    return score;
  }
  async getEvaluationAnalytics(dataset: string, tenantId = 'default'): Promise<EvaluationAnalytics> {
    const { rows } = await queryForTenant(this.pool, tenantId,
      'SELECT score_json FROM evaluation_cases WHERE dataset=$1 AND tenant_id=$2',
      [dataset, tenantId]
    );
    const scores = rows.map(
      (r) =>
        (typeof r.score_json === 'string'
          ? JSON.parse(r.score_json)
          : r.score_json) as EvaluationScore
    );
    type ScoreField = keyof EvaluationScore['baseline'];
    const aggregate = (key: 'baseline' | 'graph') => {
      const mean = (field: ScoreField) =>
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
    dataset: string,
    tenantId = 'default'
  ): Promise<Array<{ caseId: string; recordedAt: string; score: EvaluationScore }>> {
    const { rows } = await queryForTenant(this.pool, tenantId,
      'SELECT case_id,recorded_at,score_json FROM evaluation_cases WHERE dataset=$1 AND tenant_id=$2 ORDER BY case_id',
      [dataset, tenantId]
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
  const pool = new Pool({
    connectionString: normalizePostgresSslMode(connectionString),
    max: 10,
    application_name: 'tracemind-api',
  });
  pool.on('error', (error) => console.error('PostgreSQL pool error', error));
  const migrationConnectionString = process.env.TRACEMIND_DATABASE_MIGRATION_URL;
  const migrationPool = migrationConnectionString
    ? new Pool({
        connectionString: normalizePostgresSslMode(migrationConnectionString),
        max: 2,
        application_name: 'tracemind-migrations',
      })
    : pool;
  const runtimeRole = process.env.TRACEMIND_DATABASE_RUNTIME_ROLE || decodeURIComponent(new URL(connectionString).username);
  try {
    const { rows } = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user'
    );
    if (!rows[0] || rows[0].rolsuper || rows[0].rolbypassrls || rows[0].current_user !== runtimeRole)
      throw new Error('PostgreSQL runtime role must match TRACEMIND_DATABASE_RUNTIME_ROLE and be neither SUPERUSER nor BYPASSRLS');
    await migratePostgres(migrationPool, runtimeRole);
  } catch (error) {
    if (migrationPool !== pool) await migrationPool.end();
    await pool.end();
    throw error;
  }
  return {
    pool,
    migrationPool,
    runtimeRole,
    incidentStore: new PostgresIncidentStore(pool),
    workflowStore: new PostgresWorkflowStore(pool),
    graphOutbox: new PostgresGraphOutbox(pool),
    close: async () => {
      if (migrationPool !== pool) await migrationPool.end();
      await pool.end();
    },
  };
}

/**
 * node-postgres currently treats `prefer`, `require`, and `verify-ca` as
 * aliases for `verify-full` and emits a deprecation warning for them. Make the
 * currently effective behavior explicit so the same URL remains stable when
 * the dependency changes its alias semantics.
 */
export function normalizePostgresSslMode(connectionString: string): string {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get('sslmode')?.toLowerCase();
  if (sslMode === 'prefer' || sslMode === 'require' || sslMode === 'verify-ca') {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}

async function checkPostgresSchema(pool: Pool): Promise<void> {
  const result = await pool.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
  );
  if (result.rows[0]?.version !== 4) throw new Error('PostgreSQL schema is not current');
}

async function transaction<T>(
  pool: Pool,
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  return transactionForTenant(pool, tenantId, callback);
}
async function addIncidentEvent(
  c: PoolClient,
  id: string,
  action: string,
  detail: string,
  actor: string,
  at: string,
  tenantId = 'default'
) {
  await c.query(
    'INSERT INTO incident_events(incident_id,action,detail,actor,created_at,tenant_id) VALUES($1,$2,$3,$4,$5,$6)',
    [id, action, detail, actor, at, tenantId]
  );
}
async function addWorkflowEvent(
  c: PoolClient,
  planId: string,
  stepId: string | null,
  action: string,
  actor: string,
  detail: string,
  tenantId = 'default'
) {
  await c.query(
    'INSERT INTO remediation_events(plan_id,step_id,action,actor,detail,created_at,tenant_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [planId, stepId, action, actor, detail, new Date().toISOString(), tenantId]
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
type PlanPgRow = {
  id: string;
  incident_id: string;
  title: string;
  created_at: Date | string;
  created_by: string;
};
type StepPgRow = {
  id: string;
  action_id: string;
  post_check_id: string;
  rollback_action_id: string;
  description: string;
  status: RemediationStep['status'];
  rollback_approved: boolean;
  rollback_approved_by: string | null;
  verification_reconciled_by: string | null;
  approved_by: string | null;
  executed_by: string | null;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
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
    ...(r.approved_by ? { approvedBy: r.approved_by } : {}),
    ...(r.rollback_approved_by ? { rollbackApprovedBy: r.rollback_approved_by } : {}),
    ...(r.verification_reconciled_by ? { verificationReconciledBy: r.verification_reconciled_by } : {}),
    ...(r.executed_by ? { executedBy: r.executed_by } : {}),
    ...(r.execution_result ? { executionResult: json(r.execution_result) } : {}),
    ...(r.verification_result ? { verificationResult: json(r.verification_result) } : {}),
    ...(r.rollback_result ? { rollbackResult: json(r.rollback_result) } : {}),
  };
}
