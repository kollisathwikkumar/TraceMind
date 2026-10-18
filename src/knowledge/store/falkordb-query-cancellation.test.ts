import { describe, expect, it, vi } from 'vitest';
import {
  FalkorDBStore,
  GRAPH_EVIDENCE_QUERY_TIMEOUT_MS,
  type FalkorGraphPort,
} from './falkordb-store';

describe('FalkorDB query cancellation preflight', () => {
  it('does not start a graph query when the investigation signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const roQuery = vi.fn();
    const store = new FalkorDBStore({ roQuery } as unknown as FalkorGraphPort);

    await expect(
      store.findIncidentEvidencePaths('tenant-a', 'incident-a', 3, controller.signal)
    ).rejects.toThrow('caller cancelled');
    expect(roQuery).not.toHaveBeenCalled();
  });

  it('sets the bounded FalkorDB server-side timeout on incident traversal', async () => {
    const roQuery = vi.fn().mockResolvedValue({ headers: [], data: [] });
    const store = new FalkorDBStore({ roQuery } as unknown as FalkorGraphPort);

    await expect(store.findIncidentEvidencePaths('tenant-a', 'incident-a')).resolves.toEqual([]);

    expect(roQuery).toHaveBeenCalledOnce();
    expect(roQuery.mock.calls[0][1]).toEqual({
      params: { orgId: 'tenant-a', incidentId: 'incident-a' },
      TIMEOUT: GRAPH_EVIDENCE_QUERY_TIMEOUT_MS,
    });
    expect(Number.isFinite(roQuery.mock.calls[0][1].TIMEOUT)).toBe(true);
    expect(roQuery.mock.calls[0][1].TIMEOUT).toBeGreaterThan(0);
  });
});
