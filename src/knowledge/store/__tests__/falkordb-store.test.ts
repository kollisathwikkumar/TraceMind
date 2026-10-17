import { describe, expect, it, vi } from 'vitest';
import { FalkorDBStore, type FalkorGraphPort } from '../falkordb-store';

function createGraph(): FalkorGraphPort & {
  query: ReturnType<typeof vi.fn>;
  roQuery: ReturnType<typeof vi.fn>;
} {
  return {
    query: vi.fn().mockResolvedValue({ headers: [], data: [] }),
    roQuery: vi.fn().mockResolvedValue({ headers: [], data: [] }),
  };
}

describe('FalkorDBStore', () => {
  it('probes readiness with a graph operation supported by FalkorDB RO_QUERY', async () => {
    const graph = createGraph();
    const store = new FalkorDBStore(graph);
    await expect(store.checkHealth()).resolves.toBeUndefined();
    expect(graph.roQuery).toHaveBeenCalledWith('MATCH (n) RETURN count(n) AS health');
  });

  it('upserts organization-scoped service nodes with bound parameters', async () => {
    const graph = createGraph();
    const store = new FalkorDBStore(graph);

    await store.upsertService({
      orgId: 'org-a',
      id: 'payments',
      name: 'Payments',
      serviceType: 'service',
      owner: 'payments-team',
    });

    expect(graph.query).toHaveBeenCalledOnce();
    const [query, options] = graph.query.mock.calls[0];
    expect(query).toContain('MERGE (s:Service');
    expect(query).toContain('SET s.name = $name');
    expect(options.params).toEqual({
      orgId: 'org-a',
      id: 'payments',
      name: 'Payments',
      serviceType: 'service',
      owner: 'payments-team',
      aggregateVersion: null,
    });
    expect(query).not.toContain('payments-team');
  });

  it('replays dependency and incident links with MERGE rather than CREATE', async () => {
    const graph = createGraph();
    const store = new FalkorDBStore(graph);

    await store.linkDependency({
      orgId: 'org-a',
      dependentId: 'checkout',
      dependencyId: 'payments',
      criticality: 'critical',
    });
    await store.linkIncidentToService({
      orgId: 'org-a',
      incidentId: 'inc-1',
      title: 'Latency spike',
      serviceId: 'payments',
    });

    expect(graph.query).toHaveBeenCalledTimes(2);
    expect(graph.query.mock.calls[0][0]).toContain(
      'MERGE (dependent)-[r:DEPENDS_ON]->(dependency)'
    );
    expect(graph.query.mock.calls[1][0]).toContain('MERGE (i)-[r:AFFECTS]->(s)');
    expect(graph.query.mock.calls[1][1].params).toEqual({
      orgId: 'org-a',
      incidentId: 'inc-1',
      title: 'Latency spike',
      serviceId: 'payments',
      aggregateVersion: null,
    });
  });

  it('returns normalized service-neighborhood rows from FalkorDB results', async () => {
    const graph = createGraph();
    graph.roQuery.mockResolvedValue({
      headers: ['id', 'name', 'relationship', 'direction'],
      data: [
        ['checkout', 'Checkout', 'DEPENDS_ON', 'downstream'],
        ['payments-db', 'Payments DB', 'DEPENDS_ON', 'upstream'],
      ],
    });
    const store = new FalkorDBStore(graph);

    const result = await store.getServiceNeighborhood('org-a', 'payments');

    expect(result).toEqual([
      { id: 'checkout', name: 'Checkout', relationship: 'DEPENDS_ON', direction: 'downstream' },
      { id: 'payments-db', name: 'Payments DB', relationship: 'DEPENDS_ON', direction: 'upstream' },
    ]);
    expect(graph.roQuery.mock.calls[0][1].params).toEqual({
      orgId: 'org-a',
      serviceId: 'payments',
    });
    expect(graph.roQuery.mock.calls[0][0]).toContain('neighbor.org_id = $orgId');
  });

  it('returns related incidents with shared service context', async () => {
    const graph = createGraph();
    graph.roQuery.mockResolvedValue({
      headers: ['id', 'title', 'sharedServices'],
      data: [['inc-2', 'Earlier payment timeout', ['payments', 'checkout']]],
    });
    const store = new FalkorDBStore(graph);

    await expect(store.findRelatedIncidents('org-a', 'inc-1')).resolves.toEqual([
      { id: 'inc-2', title: 'Earlier payment timeout', sharedServices: ['payments', 'checkout'] },
    ]);
  });

  it('returns multi-hop incident paths with concrete service and relationship evidence', async () => {
    const graph = createGraph();
    graph.roQuery.mockResolvedValue({
      headers: [
        'rootIncidentId',
        'rootIncidentTitle',
        'incidentId',
        'incidentTitle',
        'services',
        'edges',
      ],
      data: [
        [
          'inc-1',
          'Current outage',
          'inc-2',
          'Previous outage',
          [
            { id: 'payments', name: 'Payments' },
            { id: 'ledger', name: 'Ledger' },
          ],
          [{ from: 'payments', to: 'ledger', relationship: 'DEPENDS_ON', criticality: 'critical' }],
        ],
      ],
    });
    const store = new FalkorDBStore(graph);

    await expect(store.findIncidentEvidencePaths('org-a', 'inc-1', 3)).resolves.toEqual([
      {
        rootIncidentId: 'inc-1',
        rootIncidentTitle: 'Current outage',
        incidentId: 'inc-2',
        incidentTitle: 'Previous outage',
        services: [
          { id: 'payments', name: 'Payments' },
          { id: 'ledger', name: 'Ledger' },
        ],
        edges: [
          { from: 'payments', to: 'ledger', relationship: 'DEPENDS_ON', criticality: 'critical' },
        ],
        rationale: 'Previous outage is connected through Payments → Ledger.',
      },
    ]);
    const [query, options] = graph.roQuery.mock.calls[0];
    expect(query).toContain('DEPENDS_ON*0..3');
    expect(query).toContain('[r IN relationships(path) |');
    expect(query).toContain('ALL(n IN nodes(path) WHERE n.org_id = $orgId)');
    expect(options.params).toEqual({ orgId: 'org-a', incidentId: 'inc-1' });
  });

  it('rejects unsafe graph traversal depth outside the supported range', async () => {
    const store = new FalkorDBStore(createGraph());
    await expect(store.findIncidentEvidencePaths('org-a', 'inc-1', 0)).rejects.toThrow('depth');
  });

  it('ignores malformed graph result rows', async () => {
    const graph = createGraph();
    graph.roQuery.mockResolvedValue({ headers: ['id', 'name'], data: [[null, 'unknown']] });
    const store = new FalkorDBStore(graph);

    await expect(store.getServiceNeighborhood('org-a', 'payments')).resolves.toEqual([]);
  });
});
