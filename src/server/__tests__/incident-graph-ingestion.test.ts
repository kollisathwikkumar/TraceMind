import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../utils/config';
import type { IKnowledgeRetriever } from '../../knowledge/retriever/types';
import { IncidentStore } from '../incidents/store';
import { createRouter } from '../router';

let server: Server | undefined;
let store: IncidentStore | undefined;
let directory: string | undefined;

async function startApi(options: { withGraph?: boolean; graphCatalogStore?: unknown } = {}) {
  directory = mkdtempSync(join(tmpdir(), 'tracemind-incident-graph-'));
  store = new IncidentStore(join(directory, 'incidents.sqlite'));
  const router = createRouter({
    apiKey: 'test-key',
    retriever: { close: vi.fn() } as unknown as IKnowledgeRetriever,
    mcpServer: { close: vi.fn() } as never,
    version: 'test',
    config: DEFAULT_CONFIG,
    incidentStore: store,
    graphOrgId: 'org-a',
    graphStore: options.withGraph ? ({} as never) : undefined,
    graphCatalogStore: options.graphCatalogStore as never,
  });
  server = createServer(router);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not bound');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
  server = undefined;
  store?.close();
  store = undefined;
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('incident graph ingestion', () => {
  it('queues tenant-scoped incident-service links from incident creation data', async () => {
    const graphCatalogStore = { linkIncidentToServices: vi.fn().mockResolvedValue(undefined) };
    const base = await startApi({ withGraph: true, graphCatalogStore });
    const response = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Checkout timeout',
        severity: 'SEV-2',
        serviceIds: ['checkout', 'payments'],
      }),
    });
    const payload = (await response.json()) as { data: { id: string; title: string } };

    expect(response.status).toBe(201);
    expect(graphCatalogStore.linkIncidentToServices).toHaveBeenCalledWith({
      orgId: 'org-a',
      incidentId: payload.data.id,
      title: 'Checkout timeout',
      serviceIds: ['checkout', 'payments'],
    });
  });

  it('rejects service links when the graph projection is unavailable before creating the incident', async () => {
    const base = await startApi();
    const response = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Checkout timeout',
        severity: 'SEV-2',
        serviceIds: ['checkout'],
      }),
    });

    expect(response.status).toBe(503);
    expect(await store!.list('org-a')).toHaveLength(0);
  });

  it('rejects malformed service id lists', async () => {
    const base = await startApi({
      withGraph: true,
      graphCatalogStore: { linkIncidentToServices: vi.fn() },
    });
    const response = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Checkout timeout', severity: 'SEV-2', serviceIds: [''] }),
    });

    expect(response.status).toBe(400);
    expect(await store!.list('org-a')).toHaveLength(0);
  });

  it('returns the created incident identity when atomic graph-link enqueue fails', async () => {
    const base = await startApi({
      withGraph: true,
      graphCatalogStore: {
        linkIncidentToServices: vi.fn().mockRejectedValue(new Error('database down')),
      },
    });
    const response = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Checkout timeout',
        severity: 'SEV-2',
        serviceIds: ['checkout', 'payments'],
      }),
    });
    const payload = (await response.json()) as {
      data: { id: string };
      meta: {
        graphProjection: {
          status: string;
          requestedServiceIds: string[];
          linkedServiceIds: string[];
        };
      };
    };

    expect(response.status).toBe(201);
    expect(payload.data.id).toBeTruthy();
    expect(payload.meta.graphProjection).toEqual({
      status: 'failed',
      requestedServiceIds: ['checkout', 'payments'],
      linkedServiceIds: [],
    });
    expect(await store!.list('org-a')).toHaveLength(1);
  });
});
