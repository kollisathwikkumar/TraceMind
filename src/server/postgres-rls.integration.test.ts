import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migratePostgresKnowledge, PostgresKnowledgeStore } from '../knowledge/store/postgres';
import { migratePostgresVectorStore, PostgresVectorStore } from '../knowledge/store/postgres-vector-store';
import { migrateGraphCatalog, PostgresGraphCatalogStore } from './graph-catalog';
import {
  migratePostgres,
  PostgresGraphOutbox,
  PostgresIncidentStore,
  PostgresWorkflowStore,
} from './postgres-stores';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe.skipIf(!connectionString)('PostgreSQL FORCE RLS runtime-role integration', () => {
  it('scopes every tenant store and blocks cross-tenant selects, updates, and writes as a non-owner role', async () => {
    const schema = `rls_it_${randomUUID().replaceAll('-', '')}`;
    const runtimeRole = `tm_rls_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString });
    let migrationPool: Pool | undefined;
    let appPool: Pool | undefined;
    let roleCreated = false;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      migrationPool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      await migratePostgres(migrationPool);
      await migrateGraphCatalog(migrationPool);
      await migratePostgresKnowledge(migrationPool);
      await migratePostgresVectorStore(migrationPool);

      await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      roleCreated = true;
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO ${runtimeRole}`);
      await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO ${runtimeRole}`);
      await admin.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO ${runtimeRole}`);
      appPool = new Pool({ connectionString, options: `-c search_path=${schema} -c role=${runtimeRole}` });

      const role = await appPool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user'
      );
      expect(role.rows[0]).toEqual({ current_user: runtimeRole, rolsuper: false, rolbypassrls: false });

      const incidents = new PostgresIncidentStore(appPool);
      const workflows = new PostgresWorkflowStore(appPool);
      const incidentA = await incidents.create({ title: 'A private incident', severity: 'SEV-2' }, 'a-user', 'org-a');
      await incidents.create({ title: 'B private incident', severity: 'SEV-2' }, 'b-user', 'org-b');
      expect(await incidents.list('org-a')).toHaveLength(1);
      expect(await incidents.get(incidentA.id, 'org-b')).toBeUndefined();

      const planA = await workflows.createPlan(
        incidentA.id,
        'A plan',
        [{ actionId: 'a', postCheckId: 'b', rollbackActionId: 'c', description: 'A-only' }],
        'a-user',
        'org-a'
      );
      expect(await workflows.getPlan(planA.id, 'org-b')).toBeUndefined();
      await workflows.recordEvaluation({
        dataset: 'shared', caseId: 'case', groundTruthRootCause: 'a', relevantEvidenceIds: [],
        expectedFixOutcome: 'succeeded',
        baseline: { rootCause: 'a', evidenceIds: [], fixOutcome: 'succeeded' },
        graph: { rootCause: 'a', evidenceIds: [], fixOutcome: 'succeeded' },
      }, 'org-a');
      expect(await workflows.listEvaluations('shared', 'org-b')).toHaveLength(0);

      const graph = new PostgresGraphCatalogStore(appPool, 'org-a');
      await graph.upsertService({ orgId: 'org-a', id: 'svc', name: 'A service' });
      await graph.upsertService({ orgId: 'org-b', id: 'svc', name: 'B service' });
      const projected: string[] = [];
      expect(await graph.replay({
        async upsertService(x) { projected.push(`${x.orgId}:${x.name}`); },
        async linkDependency() {},
        async linkIncidentToService() {},
      }, 'org-a')).toEqual({ processed: 1, failed: 0 });
      expect(projected).toEqual(['org-a:A service']);
      expect(await graph.checkHealth('org-b')).toBe(1);

      const legacyOutbox = new PostgresGraphOutbox(appPool);
      await legacyOutbox.enqueue({ type: 'service.upsert', orgId: 'org-a', data: { id: 'legacy', name: 'A legacy' } });
      await legacyOutbox.enqueue({ type: 'service.upsert', orgId: 'org-b', data: { id: 'legacy', name: 'B legacy' } });
      expect(await legacyOutbox.replay({ async upsertService() {}, async linkDependency() {} }, 'org-a')).toEqual({ processed: 1, failed: 0 });

      const knowledgeA = new PostgresKnowledgeStore(appPool, 'org-a', false);
      const knowledgeB = new PostgresKnowledgeStore(appPool, 'org-b', false);
      const document = {
        id: 'same-doc', type: 'runbook' as const, title: 'A guide', content: 'database restart procedure',
        source: { type: 'api' as const, name: 'fixture', config: { type: 'api' as const, endpoint: 'https://example.test' } },
        chunks: [{ id: 'same-chunk', documentId: 'same-doc', content: 'database restart procedure', chunkType: 'procedure' as const }],
        services: [], tags: [], symptoms: [], severityRelevance: [],
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
      };
      await knowledgeA.upsertDocument(document);
      await knowledgeB.upsertDocument({ ...document, title: 'B guide', content: 'private tenant b data' });
      expect((await knowledgeA.getAllDocuments()).map((d) => d.title)).toEqual(['A guide']);
      expect(await knowledgeA.getDocumentCount()).toBe(1);

      const vectorsA = new PostgresVectorStore(appPool, { tenantId: 'org-a', embedText: async () => [1, 0] });
      const vectorsB = new PostgresVectorStore(appPool, { tenantId: 'org-b', embedText: async () => [0, 1] });
      const chunk = { id: 'same-vector', documentId: 'same-doc', content: 'private', chunkType: 'procedure' as const };
      await vectorsA.addChunk(chunk, 'A', 'runbook', []);
      await vectorsB.addChunk(chunk, 'B', 'runbook', []);
      expect(await vectorsA.getCount()).toBe(1);
      expect(await vectorsA.hasDocument('same-doc')).toBe(true);

      const raw = await appPool.connect();
      try {
        await raw.query('BEGIN');
        await raw.query("SELECT set_config('app.tenant_id','org-a',true)");
        expect((await raw.query('SELECT tenant_id FROM incidents ORDER BY tenant_id')).rows)
          .toEqual([{ tenant_id: 'org-a' }]);
        expect((await raw.query("UPDATE incidents SET title='tampered' WHERE tenant_id='org-b'")).rowCount).toBe(0);
        await expect(raw.query(
          "INSERT INTO incidents(id,title,description,severity,status,created_at,updated_at,tenant_id) VALUES('forbidden','x','','SEV-3','open',NOW(),NOW(),'org-b')"
        )).rejects.toMatchObject({ code: '42501' });
        await raw.query('ROLLBACK');
      } finally {
        raw.release();
      }

      const protectedTables = [
        'incidents','incident_events','remediation_plans','remediation_steps','remediation_events','evaluation_cases',
        'graph_projection_outbox','graph_catalog_services','graph_catalog_dependencies','graph_catalog_incident_services',
        'graph_catalog_outbox','knowledge_documents','knowledge_chunks','knowledge_vector_embeddings',
      ];
      const security = await migrationPool.query<{ relname: string; relforcerowsecurity: boolean }>(
        `SELECT c.relname,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`, [schema, protectedTables]
      );
      expect(security.rows).toHaveLength(protectedTables.length);
      expect(security.rows.every((row) => row.relforcerowsecurity)).toBe(true);
    } finally {
      await appPool?.end();
      await migrationPool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (roleCreated) {
        await admin.query(`DROP OWNED BY ${runtimeRole}`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
