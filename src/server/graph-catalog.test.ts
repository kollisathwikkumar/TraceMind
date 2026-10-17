import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  migrateGraphCatalog,
  PostgresGraphCatalogStore,
  type GraphCatalogProjectionPort,
} from './graph-catalog';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;

describe('graph catalog migration bootstrap', () => {
  it('creates every catalog table before granting runtime access', async () => {
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('current_schema()')) return { rows: [{ schema_name: 'public' }] };
        return { rows: [] };
      },
      release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;

    await migrateGraphCatalog(pool, 'tracemind_runtime');

    const createTables = statements.findIndex((sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS graph_catalog_services')
    );
    const grantTables = statements.findIndex((sql) =>
      sql.startsWith('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE')
    );
    expect(createTables).toBeGreaterThan(-1);
    expect(grantTables).toBeGreaterThan(createTables);
  });
});

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
            projected.push(
              `service:${input.orgId}:${input.id}:${input.name}:v${input.aggregateVersion}`
            );
          },
          async linkDependency(input) {
            projected.push(
              `dependency:${input.orgId}:${input.dependentId}:${input.dependencyId}:v${input.aggregateVersion}`
            );
          },
          async linkIncidentToService(input) {
            projected.push(
              `incident:${input.orgId}:${input.incidentId}:${input.serviceId}:v${input.aggregateVersion}`
            );
          },
        };
        expect(await catalog.replay(graph, 'org-a')).toEqual({ processed: 4, failed: 0 });
        expect(await catalog.replay(graph, 'org-b')).toEqual({ processed: 1, failed: 0 });
        expect(await catalog.replay(graph, 'org-a')).toEqual({ processed: 0, failed: 0 });
        expect(projected).toEqual(
          expect.arrayContaining([
            'service:org-a:api:API:v1',
            'service:org-a:db:Database:v1',
            'dependency:org-a:api:db:v1',
            'incident:org-a:inc-1:api:v1',
            'service:org-b:api:Other tenant API:v1',
          ])
        );
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

    it('continues aggregate versions across legacy delimiter IDs and tuple-v1 IDs', async () => {
      const schema = `graph_catalog_legacy_versions_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);
        await pool.query(
          `INSERT INTO graph_catalog_outbox(org_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload)
           VALUES($1,'dependency',$2,41,'dependency.link',$3::jsonb)`,
          [
            'org-a',
            'api->db',
            JSON.stringify({ dependentId: 'api', dependencyId: 'db', criticality: 'critical' }),
          ]
        );

        await catalog.linkDependency({ orgId: 'org-a', dependentId: 'api', dependencyId: 'db' });
        await catalog.unlinkDependency({ orgId: 'org-a', dependentId: 'api', dependencyId: 'db' });
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'api',
          dependencyId: 'db',
          criticality: 'optional',
        });

        const rows = await pool.query<{
          aggregate_id: string;
          aggregate_version: string | number;
          event_type: string;
        }>(
          `SELECT aggregate_id,aggregate_version,event_type FROM graph_catalog_outbox
           WHERE org_id='org-a' AND aggregate_type='dependency' ORDER BY id`
        );
        expect(rows.rows.map((row) => Number(row.aggregate_version))).toEqual([41, 42, 43, 44]);
        expect(rows.rows[0].aggregate_id).toBe('api->db');
        expect(rows.rows.slice(1).every((row) => row.aggregate_id.startsWith('tuple-v1:'))).toBe(
          true
        );

        const projected: number[] = [];
        const result = await catalog.replay(
          {
            async upsertService() {},
            async linkDependency(input) {
              projected.push(input.aggregateVersion || 0);
            },
            async linkIncidentToService() {},
            async unlinkDependency(input) {
              projected.push(input.aggregateVersion || 0);
            },
          },
          'org-a'
        );
        expect(result).toEqual({ processed: 4, failed: 0 });
        expect(projected).toEqual([41, 42, 43, 44]);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });

    it('unlinks and deletes catalog records transactionally, then rebuilds only the selected tenant', async () => {
      const schema = `graph_catalog_lifecycle_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);
        await catalog.upsertService({ orgId: 'org-a', id: 'api', name: 'API' });
        await catalog.upsertService({ orgId: 'org-a', id: 'db', name: 'Database' });
        await catalog.upsertService({ orgId: 'org-a', id: 'queue', name: 'Queue' });
        await catalog.upsertService({ orgId: 'org-a', id: 'worker', name: 'Worker' });
        await catalog.upsertService({ orgId: 'org-b', id: 'api', name: 'Other API' });
        await catalog.linkDependency({ orgId: 'org-a', dependentId: 'api', dependencyId: 'db' });
        await catalog.linkDependency({ orgId: 'org-a', dependentId: 'api', dependencyId: 'queue' });
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'worker',
          dependencyId: 'queue',
        });
        await catalog.linkIncidentToServices({
          orgId: 'org-a',
          incidentId: 'inc-a',
          title: 'API failure',
          serviceIds: ['api', 'queue', 'api'],
        });
        await catalog.linkIncidentToService({
          orgId: 'org-a',
          incidentId: 'inc-b',
          title: 'Database issue',
          serviceId: 'db',
        });

        expect(
          await catalog.unlinkDependency({ orgId: 'org-a', dependentId: 'api', dependencyId: 'db' })
        ).toBe(true);
        expect(
          await catalog.unlinkDependency({ orgId: 'org-a', dependentId: 'api', dependencyId: 'db' })
        ).toBe(false);
        expect(
          await catalog.unlinkIncidentFromService({
            orgId: 'org-a',
            incidentId: 'inc-a',
            title: 'API failure',
            serviceId: 'queue',
          })
        ).toBe(true);
        expect(await catalog.deleteService('org-a', 'api')).toBe(true);
        expect(await catalog.deleteService('org-a', 'api')).toBe(false);
        // Deletion followed by recreation must produce a higher projection version.
        await catalog.upsertService({ orgId: 'org-a', id: 'api', name: 'API restored' });

        const operations: string[] = [];
        const projector: GraphCatalogProjectionPort = {
          async upsertService(x) {
            operations.push(`upsert:${x.orgId}:${x.id}:${x.name}`);
          },
          async linkDependency(x) {
            operations.push(`link:${x.dependentId}:${x.dependencyId}`);
          },
          async linkIncidentToService(x) {
            operations.push(`affects:${x.incidentId}:${x.serviceId}`);
          },
          async unlinkDependency(x) {
            operations.push(`unlink:${x.dependentId}:${x.dependencyId}`);
          },
          async unlinkIncidentFromService(x) {
            operations.push(`unaffects:${x.incidentId}:${x.serviceId}`);
          },
          async deleteService(x) {
            operations.push(`delete:${x.orgId}:${x.id}`);
          },
          async deleteOrganization(orgId) {
            operations.push(`reset:${orgId}`);
          },
        };
        const replay = await catalog.replay(projector, 'org-a', 100);
        expect(replay).toEqual({ processed: 16, failed: 0 });
        expect(operations).toEqual(
          expect.arrayContaining([
            'unlink:api:db',
            'unlink:api:queue',
            'unaffects:inc-a:api',
            'unaffects:inc-a:queue',
            'delete:org-a:api',
            'upsert:org-a:api:API restored',
          ])
        );
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM graph_catalog_services WHERE org_id='org-b'"
            )
          ).rows[0].count
        ).toBe(1);

        const rebuild: string[] = [];
        const rebuildProjector: GraphCatalogProjectionPort = {
          ...projector,
          async upsertService(x) {
            rebuild.push(`service:${x.orgId}:${x.id}:${x.name}:v${x.aggregateVersion}`);
          },
          async linkDependency(x) {
            rebuild.push(
              `dependency:${x.orgId}:${x.dependentId}:${x.dependencyId}:v${x.aggregateVersion}`
            );
          },
          async linkIncidentToService(x) {
            rebuild.push(
              `incident:${x.orgId}:${x.incidentId}:${x.serviceId}:v${x.aggregateVersion}`
            );
          },
          async deleteOrganization(orgId) {
            rebuild.push(`reset:${orgId}`);
          },
        };
        await expect(catalog.reconcile(rebuildProjector, 'org-a', 1)).rejects.toThrow(
          'Graph reconciliation exceeds the 1 record limit'
        );
        expect(rebuild).toEqual([]);
        const result = await catalog.reconcile(rebuildProjector, 'org-a');
        expect(result).toEqual({ services: 4, dependencies: 1, incidentLinks: 1 });
        expect(rebuild).toEqual(
          expect.arrayContaining([
            'reset:org-a',
            'service:org-a:api:API restored:v3',
            'service:org-a:db:Database:v1',
            'service:org-a:queue:Queue:v1',
            'service:org-a:worker:Worker:v1',
            'dependency:org-a:worker:queue:v1',
            'incident:org-a:inc-b:db:v1',
          ])
        );
        expect(rebuild.some((entry) => entry.includes('org-b'))).toBe(false);
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
        const started = new Promise<void>((resolve) => {
          announceStarted = resolve;
        });
        const firstMayReturn = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        const slowGraph: GraphCatalogProjectionPort = {
          async upsertService() {
            announceStarted();
            await firstMayReturn;
          },
          async linkDependency() {},
          async linkIncidentToService() {},
        };
        const first = catalog.replay(slowGraph, 'org-a', 1);
        await started;
        await pool.query(
          "UPDATE graph_catalog_outbox SET lease_until=NOW()-INTERVAL '1 second' WHERE org_id='org-a'"
        );
        expect(
          await catalog.replay(
            {
              async upsertService() {},
              async linkDependency() {},
              async linkIncidentToService() {},
            },
            'org-a',
            1
          )
        ).toEqual({ processed: 1, failed: 0 });
        releaseFirst();
        expect(await first).toEqual({ processed: 0, failed: 0 });
        const row = (
          await pool.query('SELECT processed_at,lease_token,attempts FROM graph_catalog_outbox')
        ).rows[0];
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

    it('keeps delimiter-colliding dependency pairs as distinct aggregates and orders legacy rows by tuple identity', async () => {
      const schema = `graph_catalog_tuple_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
      try {
        await migrateGraphCatalog(pool);
        const catalog = new PostgresGraphCatalogStore(pool);
        // These pairs had the same historical dependentId + "->" + dependencyId key.
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'a->b',
          dependencyId: 'c',
          criticality: 'degraded',
        });
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'a',
          dependencyId: 'b->c',
          criticality: 'optional',
        });
        const aggregateIds = (
          await pool.query(
            "SELECT aggregate_id FROM graph_catalog_outbox WHERE aggregate_type='dependency' ORDER BY id"
          )
        ).rows.map((row: { aggregate_id: string }) => row.aggregate_id);
        expect(aggregateIds).toHaveLength(2);
        expect(new Set(aggregateIds).size).toBe(2);

        // Simulate a pending event persisted by the prior release, then append a new-format
        // update for that same edge. The SQL ordering predicate must join on payload identity.
        await pool.query(
          "UPDATE graph_catalog_outbox SET aggregate_id='a->b->c' WHERE id=(SELECT min(id) FROM graph_catalog_outbox)"
        );
        await catalog.linkDependency({
          orgId: 'org-a',
          dependentId: 'a->b',
          dependencyId: 'c',
          criticality: 'critical',
        });

        const projected: string[] = [];
        const graph: GraphCatalogProjectionPort = {
          async upsertService() {},
          async linkDependency(input) {
            projected.push(`${input.dependentId}|${input.dependencyId}:${input.criticality}`);
          },
          async linkIncidentToService() {},
        };
        // The independently colliding edge can replay, but each edge's own versions stay ordered.
        expect(await catalog.replay(graph, 'org-a', 1)).toEqual({ processed: 1, failed: 0 });
        expect(await catalog.replay(graph, 'org-a', 1)).toEqual({ processed: 1, failed: 0 });
        expect(await catalog.replay(graph, 'org-a', 1)).toEqual({ processed: 1, failed: 0 });
        expect(projected).toEqual(['a->b|c:degraded', 'a|b->c:optional', 'a->b|c:critical']);
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      }
    });
  }
);
