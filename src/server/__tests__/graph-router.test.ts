import { createServer, type Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../utils/config';
import type { FalkorDBStore } from '../../knowledge/store/falkordb-store';
import type { IKnowledgeRetriever } from '../../knowledge/retriever/types';
import { createRouter, isLocalBrowserRequest } from '../router';

const graphStore = {
  upsertService: vi.fn(),
  linkDependency: vi.fn(),
  linkIncidentToService: vi.fn(),
  getServiceNeighborhood: vi.fn(),
  findRelatedIncidents: vi.fn(),
  findIncidentEvidencePaths: vi.fn(),
};
let activeServer: Server | undefined;

async function startApi(withGraph = true): Promise<string> {
  const retriever = { close: vi.fn() } as unknown as IKnowledgeRetriever;
  const mcpServer = { close: vi.fn() } as never;
  const router = createRouter({
    apiKey: 'test-key',
    retriever,
    mcpServer,
    version: 'test',
    config: DEFAULT_CONFIG,
    graphStore: withGraph ? (graphStore as unknown as FalkorDBStore) : undefined,
    graphOrgId: 'org-test',
  });
  activeServer = createServer(router);
  await new Promise<void>((resolve) => activeServer!.listen(0, '127.0.0.1', resolve));
  const address = activeServer.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.clearAllMocks();
  if (activeServer) {
    await new Promise<void>((resolve, reject) =>
      activeServer!.close((error) => (error ? reject(error) : resolve()))
    );
    activeServer = undefined;
  }
});

describe('FalkorDB graph routes', () => {
  it('requires bearer authentication', async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/v1/graph/services/payments/neighborhood`);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('allows same-origin loopback browser requests without an API key', async () => {
    const baseUrl = await startApi();
    graphStore.getServiceNeighborhood.mockResolvedValue([]);
    const headers = {
      'Sec-Fetch-Site': 'same-origin',
      'X-TraceMind-Local-Dashboard': '1',
    };
    const config = await fetch(`${baseUrl}/api/v1/auth/config`, { headers });
    expect(await config.json()).toMatchObject({ data: { enabled: false, localAccess: true } });

    const response = await fetch(`${baseUrl}/api/v1/graph/services/payments/neighborhood`, {
      headers,
    });
    expect(response.status).toBe(200);
  });

  it('does not grant local browser access to remote hosts, clients, or cross-site requests', () => {
    const request = (
      remoteAddress: string,
      host: string,
      fetchSite: string,
      marker = '1',
      origin?: string
    ) =>
      ({
        socket: { remoteAddress },
        headers: {
          host,
          'sec-fetch-site': fetchSite,
          'x-tracemind-local-dashboard': marker,
          ...(origin ? { origin } : {}),
        },
      }) as never;
    expect(isLocalBrowserRequest(request('127.0.0.1', 'localhost:3000', 'same-origin'))).toBe(true);
    expect(
      isLocalBrowserRequest(request('127.0.0.1', 'dashboard.attacker.example', 'same-origin'))
    ).toBe(false);
    expect(isLocalBrowserRequest(request('192.0.2.10', 'localhost:3000', 'same-origin'))).toBe(
      false
    );
    expect(isLocalBrowserRequest(request('127.0.0.1', 'localhost:3000', 'cross-site'))).toBe(false);
    expect(isLocalBrowserRequest(request('127.0.0.1', 'localhost:3000', 'same-origin', ''))).toBe(
      false
    );
    expect(
      isLocalBrowserRequest(
        request('127.0.0.1', 'localhost:3000', 'cross-site', '1', 'https://attacker.example')
      )
    ).toBe(false);
  });

  it('reports an explicit unavailable state when graph support is not configured', async () => {
    const baseUrl = await startApi(false);
    const response = await fetch(`${baseUrl}/api/v1/graph/services/payments/neighborhood`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'graph_unavailable' } });
  });

  it('upserts services using the server organization and returns the graph neighborhood', async () => {
    const baseUrl = await startApi();
    graphStore.getServiceNeighborhood.mockResolvedValue([
      { id: 'checkout', name: 'Checkout', relationship: 'DEPENDS_ON', direction: 'downstream' },
    ]);

    const created = await fetch(`${baseUrl}/api/v1/graph/services`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'payments', name: 'Payments', owner: 'payments-team' }),
    });
    expect(created.status).toBe(201);
    expect(graphStore.upsertService).toHaveBeenCalledWith({
      orgId: 'org-test',
      id: 'payments',
      name: 'Payments',
      serviceType: undefined,
      owner: 'payments-team',
    });

    const neighborhood = await fetch(`${baseUrl}/api/v1/graph/services/payments/neighborhood`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(neighborhood.status).toBe(200);
    expect(await neighborhood.json()).toMatchObject({ data: [{ id: 'checkout' }] });
    expect(graphStore.getServiceNeighborhood).toHaveBeenCalledWith('org-test', 'payments');
  });

  it('validates graph write payloads and rejects self dependencies', async () => {
    const baseUrl = await startApi();
    const response = await fetch(`${baseUrl}/api/v1/graph/dependencies`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ dependentId: 'payments', dependencyId: 'payments' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(graphStore.linkDependency).not.toHaveBeenCalled();
  });

  it('serves bounded multi-hop path evidence for graph-backed recommendations', async () => {
    const baseUrl = await startApi();
    graphStore.findIncidentEvidencePaths.mockResolvedValue([
      {
        rootIncidentId: 'inc-current',
        rootIncidentTitle: 'Current incident',
        incidentId: 'inc-previous',
        incidentTitle: 'Prior database saturation',
        services: [
          { id: 'checkout', name: 'Checkout' },
          { id: 'database', name: 'Database' },
        ],
        edges: [
          { from: 'inc-current', to: 'checkout', relationship: 'AFFECTS' },
          { from: 'checkout', to: 'database', relationship: 'DEPENDS_ON', criticality: 'critical' },
          { from: 'inc-previous', to: 'database', relationship: 'AFFECTS' },
        ],
        rationale: 'Prior database saturation is connected through Checkout → Database.',
      },
    ]);
    const response = await fetch(
      `${baseUrl}/api/v1/graph/incidents/inc-current/evidence-paths?depth=3`,
      {
        headers: { Authorization: 'Bearer test-key' },
      }
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data[0]).toMatchObject({
      rootIncidentId: 'inc-current',
      incidentId: 'inc-previous',
      edges: [
        { relationship: 'AFFECTS' },
        { criticality: 'critical' },
        { relationship: 'AFFECTS' },
      ],
    });
    expect(graphStore.findIncidentEvidencePaths).toHaveBeenCalledWith('org-test', 'inc-current', 3);
  });

  it('bounds graph depth requests', async () => {
    const baseUrl = await startApi();
    const response = await fetch(
      `${baseUrl}/api/v1/graph/incidents/inc-current/evidence-paths?depth=99`,
      {
        headers: { Authorization: 'Bearer test-key' },
      }
    );
    expect(response.status).toBe(400);
    expect(graphStore.findIncidentEvidencePaths).not.toHaveBeenCalled();
  });
});
