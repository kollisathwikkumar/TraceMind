import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FalkorDB } from 'falkordb';
import { connectFalkorDB, FalkorDBStore } from '../falkordb-store';

const url = process.env.RUNBOOK_TEST_FALKORDB_URL;

describe.skipIf(!url)('FalkorDB v4+ integration (RUNBOOK_TEST_FALKORDB_URL)', () => {
  const graphName = `tracemind_test_${randomUUID().replaceAll('-', '')}`;
  let client: Awaited<ReturnType<typeof FalkorDB.connect>>;
  let graph: ReturnType<Awaited<ReturnType<typeof FalkorDB.connect>>['selectGraph']>;
  let store: FalkorDBStore;

  beforeAll(async () => {
    client = await FalkorDB.connect({ url });
    graph = client.selectGraph(graphName);
    store = new FalkorDBStore(graph);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      // The graph name is random and owned by this test run. Drop the graph key,
      // including its schema, rather than leaving test records in a shared test DB.
      const connection = await client.connection;
      await connection.sendCommand(['GRAPH.DELETE', graphName]);
    } finally {
      await client.close();
    }
  });

  it('bootstraps a new empty graph, normalizes results, isolates organizations, and replays versions idempotently', async () => {
    // A newly selected graph has no nodes or indexes. RO_QUERY must still work.
    await expect(store.checkHealth()).resolves.toBeUndefined();
    await expect(store.bootstrap()).resolves.toBeUndefined();

    await store.upsertService({ orgId: 'org-a', id: 'core', name: 'Core' });
    await store.upsertService({
      orgId: 'org-a',
      id: 'checkout',
      name: 'Checkout v2',
      aggregateVersion: 2,
    });
    await store.upsertService({ orgId: 'org-a', id: 'database', name: 'Database' });
    await store.upsertService({ orgId: 'org-b', id: 'core', name: 'Other Core' });
    await store.upsertService({ orgId: 'org-b', id: 'checkout', name: 'Other Checkout' });

    await store.linkDependency({
      orgId: 'org-a',
      dependentId: 'core',
      dependencyId: 'checkout',
      criticality: 'critical',
    });
    await store.linkDependency({
      orgId: 'org-a',
      dependentId: 'core',
      dependencyId: 'checkout',
      criticality: 'critical',
    });
    // A stale projection replay must not overwrite aggregate version 2.
    await store.upsertService({
      orgId: 'org-a',
      id: 'checkout',
      name: 'Checkout v1 stale',
      aggregateVersion: 1,
    });
    await store.linkDependency({ orgId: 'org-a', dependentId: 'core', dependencyId: 'database' });
    await store.linkDependency({ orgId: 'org-b', dependentId: 'core', dependencyId: 'checkout' });

    const orgA = await store.getServiceNeighborhood('org-a', 'core');
    const orgB = await store.getServiceNeighborhood('org-b', 'core');
    expect(orgA).toEqual([
      { id: 'checkout', name: 'Checkout v2', relationship: 'DEPENDS_ON', direction: 'downstream' },
      { id: 'database', name: 'Database', relationship: 'DEPENDS_ON', direction: 'downstream' },
    ]);
    expect(orgB).toEqual([
      {
        id: 'checkout',
        name: 'Other Checkout',
        relationship: 'DEPENDS_ON',
        direction: 'downstream',
      },
    ]);

    await store.linkIncidentToService({
      orgId: 'org-a',
      incidentId: 'inc-current',
      title: 'Current',
      serviceId: 'checkout',
      aggregateVersion: 1,
    });
    await store.linkIncidentToService({
      orgId: 'org-a',
      incidentId: 'inc-past',
      title: 'Past',
      serviceId: 'checkout',
      aggregateVersion: 1,
    });
    await store.linkIncidentToService({
      orgId: 'org-b',
      incidentId: 'inc-other',
      title: 'Other tenant',
      serviceId: 'checkout',
      aggregateVersion: 1,
    });
    await expect(store.findRelatedIncidents('org-a', 'inc-current')).resolves.toEqual([
      { id: 'inc-past', title: 'Past', sharedServices: ['Checkout v2'] },
    ]);

    const indexes = await graph.roQuery<unknown[]>('CALL db.indexes()');
    const rows = (indexes.data ?? []) as Array<{ label?: unknown; properties?: unknown }>;
    for (const label of ['Service', 'Incident']) {
      expect(
        rows.some(
          (row) =>
            row.label === label &&
            Array.isArray(row.properties) &&
            row.properties.includes('org_id') &&
            row.properties.includes('id')
        )
      ).toBe(true);
    }
  }, 30_000);

  it('connectFalkorDB bootstraps indexes on a new graph key', async () => {
    const freshGraphName = `tracemind_bootstrap_${randomUUID().replaceAll('-', '')}`;
    const connection = await connectFalkorDB(url!, freshGraphName);
    try {
      await expect(connection.store.checkHealth()).resolves.toBeUndefined();
      expect(await connection.store.getServiceNeighborhood('org-a', 'absent')).toEqual([]);
      const indexResult = await client
        .selectGraph(freshGraphName)
        .roQuery<unknown[]>('CALL db.indexes()');
      const labels = (indexResult.data ?? []).map((row) => (row as { label?: unknown }).label);
      expect(labels).toEqual(expect.arrayContaining(['Service', 'Incident']));
    } finally {
      await connection.close();
      await (await client.connection).sendCommand(['GRAPH.DELETE', freshGraphName]);
    }
  }, 30_000);

  it('blocks malformed cross-organization shared-service bridges', async () => {
    await graph.query(
      `MERGE (current:Incident {org_id: $orgId, id: $currentId})
       MERGE (past:Incident {org_id: $orgId, id: $pastId})
       MERGE (shared:Service {org_id: $otherOrgId, id: $sharedId})
       MERGE (current)-[:AFFECTS]->(shared)
       MERGE (past)-[:AFFECTS]->(shared)`,
      {
        params: {
          orgId: 'org-a',
          currentId: 'cross-current',
          pastId: 'cross-past',
          otherOrgId: 'org-b',
          sharedId: 'cross-service',
        },
      }
    );
    await expect(store.findRelatedIncidents('org-a', 'cross-current')).resolves.toEqual([]);
    await expect(store.findIncidentEvidencePaths('org-a', 'cross-current')).resolves.toEqual([]);
  }, 30_000);
});
