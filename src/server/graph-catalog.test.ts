import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  migrateGraphCatalog,
  PostgresGraphCatalogStore,
  type GraphCatalogProjectionPort,
} from './graph-catalog';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe.skipIf(!connectionString)(
  'PostgreSQL graph catalog and transactional projection outbox',
  () => {
    it('commits catalog mutations and projection events together, scopes rows by tenant, and replays idempotently', async () => {
      const schema = `graph_catalog_test_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);

        await catalog.upsertService({ orgId: 'org-a', id: 'api', name: 'API' });
        await catalog.upsertService({ orgId: 'org-a', id: 'db', name: 'Database' });
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'api',
          dependencyId: 'db',
          criticality: 'critical',
        });
        await catalog.linkIncidentToService({
          orgId: 'org-a',
          incidentId: 'inc-1',
          title: 'API timeout',
          serviceId: 'api',
        });
        await catalog.upsertService({ orgId: 'org-b', id: 'api', name: 'Other tenant API' });

        expect(
          (
            await pool.query(
              'SELECT org_id,name FROM graph_catalog_services WHERE id=$1 ORDER BY org_id',
              ['api']
            )
          ).rows
        ).toEqual([
          { org_id: 'org-a', name: 'API' },
          { org_id: 'org-b', name: 'Other tenant API' },
        ]);
        expect(
          (await pool.query('SELECT count(*)::int AS count FROM graph_catalog_outbox')).rows[0]
            .count
        ).toBe(5);

        // The database check fails after entering the transaction; neither the canonical row nor
        // its outbox event may survive the failed transaction.
        await expect(
          catalog.upsertService({ orgId: 'org-a', id: 'invalid', name: 'x'.repeat(256) })
        ).rejects.toThrow();
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS count FROM graph_catalog_services WHERE id=$1',
              ['invalid']
            )
          ).rows[0].count
        ).toBe(0);
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM graph_catalog_outbox WHERE aggregate_id='invalid'"
            )
          ).rows[0].count
        ).toBe(0);

        const projected: string[] = [];
        const graph: GraphCatalogProjectionPort = {
          async upsertService(input) {
            projected.push(`service:${input.orgId}:${input.id}:${input.name}:v${input.aggregateVersion}`);
          },
          async linkDependency(input) {
            projected.push(`dependency:${input.orgId}:${input.dependentId}:${input.dependencyId}:v${input.aggregateVersion}`);
          },
          async linkIncidentToService(input) {
            projected.push(`incident:${input.orgId}:${input.incidentId}:${input.serviceId}:v${input.aggregateVersion}`);
          },
        };
        expect(await catalog.replay(graph, 'org-a')).toEqual({ processed: 4, failed: 0 });
        expect(await catalog.replay(graph, 'org-b')).toEqual({ processed: 1, failed: 0 });
        expect(await catalog.replay(graph, 'org-a')).toEqual({ processed: 0, failed: 0 });
        expect(projected).toEqual(expect.arrayContaining([
          'service:org-a:api:API:v1',
          'service:org-a:db:Database:v1',
          'dependency:org-a:api:db:v1',
          'incident:org-a:inc-1:api:v1',
          'service:org-b:api:Other tenant API:v1',
        ]));
        expect(
          (
            await pool.query(
              'SELECT count(*)::int AS count FROM graph_catalog_outbox WHERE processed_at IS NOT NULL'
            )
          ).rows[0].count
        ).toBe(5);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it('retries failed projections without acknowledging them', async () => {
      const schema = `graph_catalog_retry_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);
        await catalog.upsertService({ orgId: 'org-a', id: 'api', name: 'API' });
        const brokenGraph: GraphCatalogProjectionPort = {
          async upsertService() {
            throw new Error('FalkorDB unavailable');
          },
          async linkDependency() {},
          async linkIncidentToService() {},
        };
        expect(await catalog.replay(brokenGraph, 'org-a')).toEqual({ processed: 0, failed: 1 });
        const row = (
          await pool.query('SELECT processed_at,last_error,attempts FROM graph_catalog_outbox')
        ).rows[0];
        expect(row.processed_at).toBeNull();
        expect(row.last_error).toBe('FalkorDB unavailable');
        expect(row.attempts).toBe(1);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it('fences a late projection worker after its lease expires and another worker completes', async () => {
      const schema = `graph_catalog_fence_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);
        await catalog.upsertService({ orgId: 'org-a', id: 'fenced', name: 'Fenced service' });
        let announceStarted!: () => void;
        let releaseFirst!: () => void;
        const started = new Promise<void>((resolve) => { announceStarted = resolve; });
        const firstMayReturn = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const slowGraph: GraphCatalogProjectionPort = {
          async upsertService() { announceStarted(); await firstMayReturn; },
          async linkDependency() {},
          async linkIncidentToService() {},
        };
        const first = catalog.replay(slowGraph, 'org-a', 1);
        await started;
        await pool.query("UPDATE graph_catalog_outbox SET lease_until=NOW()-INTERVAL '1 second' WHERE org_id='org-a'");
        expect(await catalog.replay({
          async upsertService() {}, async linkDependency() {}, async linkIncidentToService() {},
        }, 'org-a', 1)).toEqual({ processed: 1, failed: 0 });
        releaseFirst();
        expect(await first).toEqual({ processed: 0, failed: 0 });
        const row = (await pool.query('SELECT processed_at,lease_token,attempts FROM graph_catalog_outbox')).rows[0];
        expect(row.processed_at).toBeTruthy();
        expect(row.lease_token).toBeNull();
        expect(row.attempts).toBe(2);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
    it('keeps updates for the same dependency ordered and projects auto-created service stubs through the edge MERGE', async () => {
      const schema = `graph_catalog_order_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'api',
          dependencyId: 'db',
          criticality: 'degraded',
        });
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'api',
          dependencyId: 'db',
          criticality: 'critical',
        });

        // ensureService creates canonical placeholders, but intentionally does not emit separate
        // service events: FalkorDBStore.linkDependency MERGEs both endpoint nodes in the same query.
        expect(
          (await pool.query('SELECT count(*)::int AS count FROM graph_catalog_services')).rows[0]
            .count
        ).toBe(2);
        expect(
          (
            await pool.query(
              'SELECT event_type,aggregate_version FROM graph_catalog_outbox ORDER BY id'
            )
          ).rows
        ).toEqual([
          { event_type: 'dependency.link', aggregate_version: '1' },
          { event_type: 'dependency.link', aggregate_version: '2' },
        ]);

        const criticalities: string[] = [];
        const graph: GraphCatalogProjectionPort = {
          async upsertService() {},
          async linkDependency(input) {
            criticalities.push(input.criticality || 'degraded');
          },
          async linkIncidentToService() {},
        };
        expect(await catalog.replay(graph, 'org-a', 1)).toEqual({ processed: 1, failed: 0 });
        expect(await catalog.replay(graph, 'org-a', 1)).toEqual({ processed: 1, failed: 0 });
        expect(criticalities).toEqual(['degraded', 'critical']);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
  }
);
