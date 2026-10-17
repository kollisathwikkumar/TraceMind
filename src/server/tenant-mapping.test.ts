import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migratePostgres } from './postgres-stores';
import { applyLegacyTenantMapping, inventoryLegacyTenants } from './tenant-mapping';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe('explicit legacy tenant mapping', () => {
  it.skipIf(!connectionString)(
    'reports aggregate inventory and atomically maps only explicitly assigned legacy records',
    async () => {
      const schema = `tenant_map_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migratePostgres(pool);
        const now = new Date();
        await pool.query(
          `INSERT INTO incidents(id,title,description,severity,status,created_at,updated_at) VALUES ('inc-1','private title','private description','SEV-2','open',$1,$1)`,
          [now]
        );
        await pool.query(
          `INSERT INTO incident_events(incident_id,action,detail,actor,created_at) VALUES ('inc-1','created','private detail','actor',$1)`,
          [now]
        );
        await pool.query(
          `INSERT INTO remediation_plans(id,incident_id,title,created_at,created_by) VALUES ('plan-1','inc-1','private plan',$1,'author')`,
          [now]
        );
        await pool.query(
          `INSERT INTO remediation_steps(id,plan_id,action_id,post_check_id,rollback_action_id,description,status) VALUES ('step-1','plan-1','a','b','c','private step','pending')`
        );
        await pool.query(
          `INSERT INTO remediation_events(plan_id,step_id,action,actor,detail,created_at) VALUES ('plan-1','step-1','created','actor','private audit',$1)`,
          [now]
        );
        await pool.query(
          `INSERT INTO evaluation_cases(dataset,case_id,input_json,score_json,recorded_at) VALUES ('set-1','case-1','{}','{}',$1)`,
          [now]
        );
        const inventory = await inventoryLegacyTenants(pool);
        expect(inventory.incidents).toEqual([{ tenantId: 'default', count: 1 }]);
        expect(JSON.stringify(inventory)).not.toContain('private');

        await expect(
          applyLegacyTenantMapping(pool, {
            incidents: {},
            evaluationCases: [{ dataset: 'set-1', caseId: 'case-1', tenantId: 'org-a' }],
          })
        ).rejects.toThrow('Missing explicit tenant mapping for legacy incident');
        expect(
          (await pool.query(`SELECT tenant_id FROM incidents WHERE id='inc-1'`)).rows[0].tenant_id
        ).toBe('default');

        const after = await applyLegacyTenantMapping(pool, {
          incidents: { 'inc-1': 'org-a' },
          evaluationCases: [{ dataset: 'set-1', caseId: 'case-1', tenantId: 'org-b' }],
        });
        expect(after.incidents).toEqual([{ tenantId: 'org-a', count: 1 }]);
        expect(after.incident_events).toEqual([{ tenantId: 'org-a', count: 1 }]);
        expect(after.remediation_plans).toEqual([{ tenantId: 'org-a', count: 1 }]);
        expect(after.remediation_steps).toEqual([{ tenantId: 'org-a', count: 1 }]);
        expect(after.remediation_events).toEqual([{ tenantId: 'org-a', count: 1 }]);
        expect(after.evaluation_cases).toEqual([{ tenantId: 'org-b', count: 1 }]);
        const constraints = await pool.query<{ condeferrable: boolean }>(
          `SELECT condeferrable FROM pg_constraint WHERE conname='incident_events_tenant_fk'`
        );
        expect(constraints.rows[0].condeferrable).toBe(true);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    }
  );
});
