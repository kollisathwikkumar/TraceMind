import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../utils/config';
import { resolveServerDatabaseUrl } from './index';
import { migratePostgres } from './postgres-stores';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe('PostgreSQL incident/workflow persistence', () => {
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
        // Exercise repository classes on this isolated schema without affecting the caller's tables.
        const { PostgresIncidentStore, PostgresWorkflowStore } = await import('./postgres-stores');
        const incidents = new PostgresIncidentStore(pool);
        const workflows = new PostgresWorkflowStore(pool);
        const incident = await incidents.create(
          { title: 'Payment API timeout', severity: 'SEV-1' },
          'on-call'
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
          'on-call'
        );
        const step = plan.steps[0];
        await workflows.decide(
          plan.id,
          step.id,
          'approve',
          'on-call',
          'Evidence supports this bounded change'
        );
        expect(await workflows.beginExecution(plan.id, step.id, 'on-call')).toBe(true);
        await workflows.setExecution(
          plan.id,
          step.id,
          'verified',
          { succeeded: true, output: 'config updated' },
          { succeeded: true, evidence: 'health endpoint 200; latency recovered' },
          'on-call'
        );
        expect((await workflows.getPlan(plan.id))?.steps[0].status).toBe('verified');
        await workflows.decideRollback(
          plan.id,
          step.id,
          'approve',
          'on-call',
          'Regression was detected during watch window'
        );
        expect(await workflows.beginRollback(plan.id, step.id, 'on-call')).toBe(true);
        await workflows.setRollback(
          plan.id,
          step.id,
          { succeeded: true, output: 'previous setting restored' },
          'on-call'
        );
        expect((await workflows.getPlan(plan.id))?.steps[0].status).toBe('rolled_back');
        expect((await workflows.events(plan.id)).map((event) => event.action)).toEqual(
          expect.arrayContaining(['approved', 'execution_started', 'post_check_passed'])
        );

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
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    }
  );
});
