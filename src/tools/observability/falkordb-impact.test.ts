import { describe, expect, it, vi } from 'vitest';
import type { FalkorDBConnection } from '../../knowledge/store/falkordb-store';
import { createFalkorImpactTool } from './falkordb-impact';

const evidence = (id: string) => ({
  rootIncidentId: 'inc-current',
  rootIncidentTitle: 'Current incident',
  incidentId: id,
  incidentTitle: `Related ${id}`,
  services: [{ id: 'svc-a', name: 'service-a' }],
  edges: [{ from: 'inc-current', to: 'svc-a', relationship: 'AFFECTS' }],
  rationale: 'Shared topology path',
});

function fixture(paths = [evidence('inc-1'), evidence('inc-2')]) {
  const findIncidentEvidencePaths = vi.fn().mockResolvedValue(paths);
  const close = vi.fn().mockResolvedValue(undefined);
  const tool = createFalkorImpactTool({
    settings: async () => ({
      url: 'redis://falkor.local',
      graphName: 'trace-graph',
      orgId: 'org-trusted',
    }),
    connect: async () => ({
      store: { findIncidentEvidencePaths } as unknown as FalkorDBConnection['store'],
      close,
    }),
  });
  return { tool, findIncidentEvidencePaths, close };
}

describe('falkordb_incident_impact agent tool', () => {
  it('queries only the configured tenant, applies caller depth and returns attributed paths', async () => {
    const { tool, findIncidentEvidencePaths, close } = fixture();

    const result = await tool.execute({ incidentId: 'inc-current', maxDepth: 2 });

    expect(findIncidentEvidencePaths).toHaveBeenCalledWith('org-trusted', 'inc-current', 2);
    expect(close).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      source: 'FalkorDB',
      organization: 'org-trusted',
      graph: 'trace-graph',
      returned: 2,
      interpretation: expect.stringContaining('do not establish causation'),
      provenance: { relationshipTypes: ['AFFECTS', 'DEPENDS_ON'] },
      paths: [{ relatedIncident: { id: 'inc-1' } }, { relatedIncident: { id: 'inc-2' } }],
    });
  });

  it('does not accept a caller-selected tenant and caps result count at ten', async () => {
    const paths = Array.from({ length: 12 }, (_, index) => evidence(`inc-${index}`));
    const { tool } = fixture(paths);

    const result = (await tool.execute({
      incidentId: 'inc-current',
      orgId: 'other-org',
      maxResults: 10,
    })) as {
      paths: unknown[];
      returned: number;
      truncated: boolean;
    };

    expect(result.paths).toHaveLength(10);
    expect(result.returned).toBe(10);
    expect(result.truncated).toBe(true);
  });

  it.each([
    { incidentId: 'inc', maxDepth: 0 },
    { incidentId: 'inc', maxDepth: 5 },
    { incidentId: 'inc', maxDepth: 1.5 },
    { incidentId: 'inc', maxResults: 11 },
    { incidentId: '   ' },
  ])('rejects invalid or over-budget input %#', async (args) => {
    const { tool, findIncidentEvidencePaths, close } = fixture();

    await expect(tool.execute(args)).resolves.toHaveProperty('error');
    expect(findIncidentEvidencePaths).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('reports an unconfigured graph without opening a connection', async () => {
    const connect = vi.fn();
    const tool = createFalkorImpactTool({
      settings: async () => ({ graphName: 'trace-graph', orgId: 'org-trusted' }),
      connect,
    });

    await expect(tool.execute({ incidentId: 'inc-current' })).resolves.toEqual({
      error: 'FalkorDB is not configured.',
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
