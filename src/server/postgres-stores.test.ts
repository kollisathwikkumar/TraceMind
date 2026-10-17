import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../utils/config';
import { resolveServerDatabaseUrl } from './index';
import { migratePostgres, normalizePostgresSslMode } from './postgres-stores';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe('PostgreSQL incident/workflow persistence', () => {
  it('normalizes deprecated TLS aliases to their current verify-full behavior', () => {
    const normalized = normalizePostgresSslMode(
      'postgresql://user:secret@db.example/tracemind?sslmode=require&application_name=smoke'
    );
    const parsed = new URL(normalized);
    expect(parsed.searchParams.get('sslmode')).toBe('verify-full');
    expect(parsed.searchParams.get('application_name')).toBe('smoke');
    expect(normalizePostgresSslMode('postgresql://user:secret@db.example/tracemind?sslmode=disable'))
      .toContain('sslmode=disable');
    expect(() => normalizePostgresSslMode('not-a-postgres-url')).toThrow();
  });

  it('prefers TraceMind variables, preserves migration aliases, and keeps config as fallback', () => {
    const configured = {
      ...DEFAULT_CONFIG,
      server: { ...DEFAULT_CONFIG.server, databaseUrl: 'postgresql://config/db' },
    };
    expect(
      resolveServerDatabaseUrl(configured, {
        TRACEMIND_DATABASE_URL: 'postgresql://tracemind/db',
        RUNBOOK_DATABASE_URL: 'postgresql://legacy/db',
      })
    ).toBe('postgresql://tracemind/db');
    expect(
      resolveServerDatabaseUrl(configured, { RUNBOOK_DATABASE_URL: 'postgresql://env/db' })
    ).toBe('postgresql://env/db');
    expect(resolveServerDatabaseUrl(configured, {})).toBe('postgresql://config/db');
  });

  it.skipIf(!connectionString)(
    'migrates and persists incidents, approvals, audit events, outcomes and evaluation analytics',
    async () => {
      const schema = `tracemind_test_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migratePostgres(pool);
        expect(
          (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows
        ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
        // Exercise repository classes on this isolated schema without affecting the caller's tables.
        const { PostgresGraphOutbox, PostgresIncidentStore, PostgresWorkflowStore } = await import('./postgres-stores');
        const incidents = new PostgresIncidentStore(pool);
        const workflows = new PostgresWorkflowStore(pool);
        const tenantA = await incidents.create(
          { title: 'Tenant A private incident', severity: 'SEV-2' },
          'tenant-a-user',
          'org-a'
        );
        await incidents.create(
          { title: 'Tenant B private incident', severity: 'SEV-2' },
          'tenant-b-user',
          'org-b'
        );
        expect(await incidents.get(tenantA.id, 'org-b')).toBeUndefined();
        expect(await incidents.list('org-a')).toHaveLength(1);
        expect(await incidents.list('org-b')).toHaveLength(1);
        expect(await incidents.update(tenantA.id, { title: 'tampered' }, 'attacker', 'org-b'))
          .toBeUndefined();
        expect((await incidents.events(tenantA.id, 'org-b'))).toEqual([]);
        const tenantAPlan = await workflows.createPlan(
          tenantA.id,
          'Tenant A plan',
          [{ actionId: 'a', postCheckId: 'b', rollbackActionId: 'c', description: 'private' }],
          'tenant-a-user',
          'org-a'
        );
        expect(await workflows.getPlan(tenantAPlan.id, 'org-b')).toBeUndefined();
        expect(await workflows.events(tenantAPlan.id, 'org-b')).toEqual([]);
        expect(await workflows.decide(tenantAPlan.id, tenantAPlan.steps[0].id, 'approve', 'intruder', 'reason', 'org-b'))
          .toBeUndefined();
        const caseInput = {
          dataset: 'shared', caseId: 'same-key', groundTruthRootCause: 'A', relevantEvidenceIds: ['e'],
          expectedFixOutcome: 'succeeded' as const,
          baseline: { rootCause: 'A', evidenceIds: ['e'], fixOutcome: 'succeeded' as const },
          graph: { rootCause: 'A', evidenceIds: ['e'], fixOutcome: 'succeeded' as const },
        };
        await workflows.recordEvaluation(caseInput, 'org-a');
        await workflows.recordEvaluation({ ...caseInput, groundTruthRootCause: 'B' }, 'org-b');
        expect(await workflows.listEvaluations('shared', 'org-a')).toHaveLength(1);
        expect(await workflows.listEvaluations('shared', 'org-b')).toHaveLength(1);
        expect((await workflows.getEvaluationAnalytics('shared', 'org-a')).graph.rootCauseAccuracy).toBe(1);
        expect((await workflows.getEvaluationAnalytics('shared', 'org-b')).graph.rootCauseAccuracy).toBe(0);
        const incident = await incidents.create(
          { title: 'Payment API timeout', severity: 'SEV-1' },
          'requester'
        );
        expect((await incidents.get(incident.id))?.status).toBe('open');
        const plan = await workflows.createPlan(
          incident.id,
          'Increase pool after verification',
          [
            {
              actionId: 'pool-capacity-fix',
              postCheckId: 'payment-health',
              rollbackActionId: 'pool-capacity-restore',
              description: 'Adjust the registered connection pool setting',
            },
          ],
          'requester'
        );
        const step = plan.steps[0];
        await workflows.decide(
          plan.id,
          step.id,
          'approve',
          'approver',
          'Evidence supports this bounded change'
        );
        await expect(workflows.beginExecution(plan.id, step.id, 'approver', 'approver-lease-token')).rejects.toThrow();
        const executionLease = 'execution-lease-token';
        expect(await workflows.beginExecution(plan.id, step.id, 'executor', executionLease)).toBe(true);
        await workflows.setExecution(
          plan.id,
          step.id,
          'verified',
          { succeeded: true, output: 'config updated' },
          { succeeded: true, evidence: 'health endpoint 200; latency recovered' },
          'executor',
          executionLease
        );
        expect((await workflows.getPlan(plan.id))?.steps[0].status).toBe('verified');
        await workflows.decideRollback(
          plan.id,
          step.id,
          'approve',
          'rollback-approver',
          'Regression was detected during watch window'
        );
        expect((await workflows.getPlan(plan.id))?.steps[0].rollbackApprovedBy).toBe('rollback-approver');
        await pool.query('UPDATE remediation_steps SET rollback_approved_by=NULL WHERE plan_id=$1 AND id=$2', [plan.id, step.id]);
        expect(await workflows.beginRollback(plan.id, step.id, 'legacy-rollback-executor', 'legacy-lease')).toBe(false);
        await pool.query('UPDATE remediation_steps SET rollback_approved_by=$3 WHERE plan_id=$1 AND id=$2', [plan.id, step.id, 'rollback-approver']);
        expect(await workflows.beginRollback(plan.id, step.id, 'rollback-approver', 'same-person')).toBe(false);
        const rollbackLease = 'rollback-lease-token';
        expect(await workflows.beginRollback(plan.id, step.id, 'rollback-executor', rollbackLease)).toBe(true);
        await workflows.setRollback(
          plan.id,
          step.id,
          { succeeded: true, output: 'previous setting restored' },
          'rollback-executor',
          rollbackLease
        );
        expect((await workflows.getPlan(plan.id))?.steps[0].status).toBe('rolled_back');
        expect((await workflows.events(plan.id)).map((event) => event.action)).toEqual(
          expect.arrayContaining(['approved', 'execution_started', 'post_check_passed'])
        );

        const interrupted = await workflows.createPlan(
          incident.id,
          'Interrupted action',
          [{ actionId: 'a', postCheckId: 'c', rollbackActionId: 'r', description: 'interrupted' }],
          'requester'
        );
        await workflows.decide(interrupted.id, interrupted.steps[0].id, 'approve', 'approver', 'approved');
        const interruptedLease = 'interrupted-lease-token';
        expect(await workflows.beginExecution(interrupted.id, interrupted.steps[0].id, 'executor', interruptedLease)).toBe(true);
        expect(await workflows.reconcileExpiredLeases('reconciler', new Date(Date.now() + 120_000), 'default')).toBe(1);
        expect((await workflows.getPlan(interrupted.id))?.steps[0].status).toBe('execution_unknown');
        expect(await workflows.setExecution(
          interrupted.id,
          interrupted.steps[0].id,
          'verified',
          { succeeded: true, output: 'late result' },
          { succeeded: true, evidence: 'late check' },
          'executor',
          interruptedLease
        )).toBe(false);
        expect((await workflows.getPlan(interrupted.id))?.steps[0].status).toBe('execution_unknown');
        expect(await workflows.resolveUnknown(interrupted.id, interrupted.steps[0].id, 'execute', true, 'Broker idempotency record and independent post-check confirm applied action', 'operator:reconcile')).toBe(true);
        expect((await workflows.getPlan(interrupted.id))?.steps[0].status).toBe('execution_succeeded');
        expect((await workflows.events(interrupted.id)).some((event) => event.action === 'execute_reconciled' && event.actor === 'operator:reconcile')).toBe(true);

        const uncertainCheck = await workflows.createPlan(
          incident.id,
          'Post-check response lost',
          [{ actionId: 'action', postCheckId: 'check', rollbackActionId: 'rollback', description: 'uncertain check' }],
          'requester'
        );
        const uncertainStep = uncertainCheck.steps[0];
        await workflows.decide(uncertainCheck.id, uncertainStep.id, 'approve', 'approver', 'approved');
        expect(await workflows.beginExecution(uncertainCheck.id, uncertainStep.id, 'executor', 'verify-lease')).toBe(true);
        expect(await workflows.setExecution(
          uncertainCheck.id,
          uncertainStep.id,
          'verification_unknown',
          { succeeded: true, output: 'action applied' },
          { succeeded: false, error: 'Verification outcome unknown: timeout' },
          'executor',
          'verify-lease'
        )).toBe(true);
        await expect(workflows.decideRollback(
          uncertainCheck.id,
          uncertainStep.id,
          'approve',
          'rollback-approver',
          'verification is ambiguous'
        )).rejects.toThrow('Rollback approval requires an executed remediation step');
        expect(await workflows.resolveUnknown(
          uncertainCheck.id,
          uncertainStep.id,
          'verify',
          true,
          'Independent post-check confirms service health',
          'operator:verify'
        )).toBe(true);
        expect((await workflows.getPlan(uncertainCheck.id))?.steps[0].status).toBe('verified');
        expect((await workflows.getPlan(uncertainCheck.id))?.steps[0].verificationReconciledBy).toBe('operator:verify');
        await expect(workflows.decideRollback(
          uncertainCheck.id,
          uncertainStep.id,
          'approve',
          'operator:verify',
          'same person'
        )).rejects.toThrow('verification reconciler');
        await workflows.decideRollback(uncertainCheck.id, uncertainStep.id, 'approve', 'rollback-approver', 'separate approval');
        await pool.query('UPDATE remediation_steps SET rollback_approved_by=$3 WHERE plan_id=$1 AND id=$2', [uncertainCheck.id, uncertainStep.id, 'operator:verify']);
        expect(await workflows.beginRollback(uncertainCheck.id, uncertainStep.id, 'rollback-executor', 'same-approval-lease')).toBe(false);
        await pool.query('UPDATE remediation_steps SET rollback_approved_by=$3 WHERE plan_id=$1 AND id=$2', [uncertainCheck.id, uncertainStep.id, 'rollback-approver']);
        expect(await workflows.beginRollback(uncertainCheck.id, uncertainStep.id, 'operator:verify', 'same-person-rollback-lease')).toBe(false);
        expect(await workflows.beginRollback(uncertainCheck.id, uncertainStep.id, 'rollback-executor', 'distinct-rollback-lease')).toBe(true);

        const score = await workflows.recordEvaluation({
          dataset: 'known-incidents',
          caseId: 'payment-timeout-1',
          groundTruthRootCause: 'connection pool exhaustion',
          relevantEvidenceIds: ['db-pool'],
          expectedFixOutcome: 'succeeded',
          baseline: { rootCause: 'database latency', evidenceIds: [], fixOutcome: 'failed' },
          graph: {
            rootCause: 'connection pool exhaustion',
            evidenceIds: ['db-pool'],
            fixOutcome: 'succeeded',
          },
        });
        expect(score.graph.rootCauseCorrect).toBe(true);
        expect(
          (await workflows.getEvaluationAnalytics('known-incidents')).graph.rootCauseAccuracy
        ).toBe(1);
        expect(await workflows.listEvaluations('known-incidents')).toHaveLength(1);

        const outbox = new PostgresGraphOutbox(pool);
        await outbox.enqueue({
          type: 'service.upsert',
          orgId: 'test-org',
          data: { id: 'svc-outbox', name: 'outbox replay test' },
        });
        const projected: string[] = [];
        const replay = await outbox.replay({
          async upsertService(input) { projected.push(`service:${input.orgId}:${input.id}`); },
          async linkDependency(input) { projected.push(`dependency:${input.orgId}:${input.dependentId}`); },
        }, 'test-org');
        expect(replay).toEqual({ processed: 1, failed: 0 });
        expect(projected).toEqual(['service:test-org:svc-outbox']);
        expect((await pool.query('SELECT processed_at FROM graph_projection_outbox')).rows[0].processed_at).toBeTruthy();
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    }
  );

  it.skipIf(!connectionString)('upgrades legacy evaluation keys without cross-tenant uniqueness collisions', async () => {
    const schema = `tracemind_legacy_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await pool.query(`
        CREATE TABLE evaluation_cases (
          dataset TEXT NOT NULL, case_id TEXT NOT NULL, input_json JSONB NOT NULL,
          score_json JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY(dataset,case_id)
        );
        INSERT INTO evaluation_cases VALUES ('legacy','case-1','{}','{}',NOW());
      `);
      await migratePostgres(pool);
      const keys = await pool.query<{ pg_get_constraintdef: string }>(
        `SELECT pg_get_constraintdef(oid) FROM pg_constraint
          WHERE conrelid='evaluation_cases'::regclass AND contype='p'`
      );
      expect(keys.rows[0]?.pg_get_constraintdef).toContain('tenant_id');
      await pool.query(
        `INSERT INTO evaluation_cases(dataset,case_id,input_json,score_json,recorded_at,tenant_id)
         VALUES ('legacy','case-1','{}','{}',NOW(),'org-b')`
      );
      expect((await pool.query('SELECT tenant_id FROM evaluation_cases ORDER BY tenant_id')).rows)
        .toEqual([{ tenant_id: 'default' }, { tenant_id: 'org-b' }]);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it.skipIf(!connectionString)('adds lease fencing to legacy projection outbox rows and replays them', async () => {
    const schema = `legacy_outbox_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await pool.query(`CREATE TABLE graph_projection_outbox (
        id BIGSERIAL PRIMARY KEY, org_id TEXT NOT NULL, event_type TEXT NOT NULL,
        payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        attempts INTEGER NOT NULL DEFAULT 0, available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        lease_until TIMESTAMPTZ, processed_at TIMESTAMPTZ, last_error TEXT
      )`);
      await pool.query(`INSERT INTO graph_projection_outbox(org_id,event_type,payload)
        VALUES('legacy-org','service.upsert','{"id":"legacy-service","name":"Legacy service"}')`);
      await migratePostgres(pool);
      const { PostgresGraphOutbox } = await import('./postgres-stores');
      const outbox = new PostgresGraphOutbox(pool);
      const projected: string[] = [];
      expect(await outbox.replay({
        async upsertService(input) { projected.push(`${input.orgId}:${input.id}`); },
        async linkDependency() {},
      }, 'legacy-org')).toEqual({ processed: 1, failed: 0 });
      expect(projected).toEqual(['legacy-org:legacy-service']);
      expect((await pool.query('SELECT processed_at,lease_token FROM graph_projection_outbox')).rows[0]).toMatchObject({
        processed_at: expect.any(Date), lease_token: null,
      });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
  it.skipIf(!connectionString)('adds nullable reconciler identity while preserving legacy approval rows', async () => {
    const schema = `legacy_verifier_sod_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await pool.query(`
        CREATE TABLE incidents (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          severity TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT,
          created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
        );
        INSERT INTO incidents VALUES ('legacy-inc','legacy','', 'SEV-2','open',NULL,NOW(),NOW());
        CREATE TABLE remediation_plans (
          id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id), title TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL, created_by TEXT NOT NULL
        );
        INSERT INTO remediation_plans VALUES ('legacy-plan','legacy-inc','legacy',NOW(),'proposer');
        CREATE TABLE remediation_steps (
          id TEXT NOT NULL, plan_id TEXT NOT NULL REFERENCES remediation_plans(id) ON DELETE CASCADE,
          action_id TEXT NOT NULL, post_check_id TEXT NOT NULL, rollback_action_id TEXT NOT NULL,
          description TEXT NOT NULL, status TEXT NOT NULL, rollback_approved BOOLEAN NOT NULL DEFAULT FALSE,
          approved_by TEXT, rollback_approved_by TEXT, executed_by TEXT, lease_token TEXT, lease_expires_at TIMESTAMPTZ,
          execution_result JSONB, verification_result JSONB, rollback_result JSONB,
          PRIMARY KEY(plan_id,id)
        );
        INSERT INTO remediation_steps(id,plan_id,action_id,post_check_id,rollback_action_id,description,status,rollback_approved,rollback_approved_by,verification_result)
          VALUES('legacy-step','legacy-plan','a','c','r','legacy','verified',TRUE,'legacy-rollback-approver','{"succeeded":true}');
      `);
      await migratePostgres(pool);
      expect((await pool.query(
        `SELECT rollback_approved,rollback_approved_by,verification_reconciled_by FROM remediation_steps WHERE id='legacy-step'`
      )).rows[0]).toEqual({
        rollback_approved: true,
        rollback_approved_by: 'legacy-rollback-approver',
        verification_reconciled_by: null,
      });
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
});
