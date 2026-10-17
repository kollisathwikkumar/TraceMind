import { createServer, type Server } from 'http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../utils/config';
import type { FalkorDBStore } from '../../knowledge/store/falkordb-store';
import type { IKnowledgeRetriever } from '../../knowledge/retriever/types';
import { createRouter, isLocalBrowserRequest, type RouterConfig } from '../router';

const graphStore = {
  upsertService: vi.fn(),
  linkDependency: vi.fn(),
  linkIncidentToService: vi.fn(),
  getServiceNeighborhood: vi.fn(),
  findRelatedIncidents: vi.fn(),
  findIncidentEvidencePaths: vi.fn(),
  deleteService: vi.fn(),
  unlinkDependency: vi.fn(),
  unlinkIncidentFromService: vi.fn(),
  checkHealth: vi.fn(),
};
let activeServer: Server | undefined;

async function startApi(withGraph = true, extras: Partial<RouterConfig> = {}): Promise<string> {
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
    ...extras,
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

  it('scopes authenticated Auth0 graph reads and writes to the verified organization', async () => {
    graphStore.getServiceNeighborhood.mockImplementation(async (orgId: string) => [
      { id: `${orgId}-service`, name: orgId, relationship: 'DEPENDS_ON', direction: 'downstream' },
    ]);
    const baseUrl = await startApi(true, {
      auth0OrgIds: ['org-a', 'org-b'],
      verifyAuth0Token: vi.fn(async (token: string) => ({
        sub: `auth0|${token}`,
        organizationId: token,
        scopes: ['graph:read', 'graph:write'],
        roles: [],
      })),
    });

    for (const orgId of ['org-a', 'org-b']) {
      const response = await fetch(`${baseUrl}/api/v1/graph/services/core/neighborhood`, {
        headers: { Authorization: `Bearer ${orgId}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: [{ id: `${orgId}-service` }] });
    }

    const write = await fetch(`${baseUrl}/api/v1/graph/services`, {
      method: 'POST',
      headers: { Authorization: 'Bearer org-b', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'core', name: 'Core' }),
    });
    expect(write.status).toBe(201);
    expect(graphStore.getServiceNeighborhood).toHaveBeenNthCalledWith(1, 'org-a', 'core');
    expect(graphStore.getServiceNeighborhood).toHaveBeenNthCalledWith(2, 'org-b', 'core');
    expect(graphStore.upsertService).toHaveBeenCalledWith({
      orgId: 'org-b',
      id: 'core',
      name: 'Core',
      serviceType: undefined,
      owner: undefined,
    });
  });

  it('rejects unconfigured Auth0 organizations and missing graph scopes before graph access', async () => {
    const baseUrl = await startApi(true, {
      auth0OrgIds: ['org-a'],
      verifyAuth0Token: vi.fn(async (token: string) => ({
        sub: `auth0|${token}`,
        organizationId: token.startsWith('org-a') ? 'org-a' : token,
        scopes: token === 'org-a-no-scope' ? [] : ['graph:read'],
        roles: [],
      })),
    });

    const forbidden = await fetch(`${baseUrl}/api/v1/graph/services/core/neighborhood`, {
      headers: { Authorization: 'Bearer org-b' },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: 'tenant_forbidden' } });

    const insufficient = await fetch(`${baseUrl}/api/v1/graph/services`, {
      method: 'POST',
      headers: { Authorization: 'Bearer org-a-no-scope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'core', name: 'Core' }),
    });
    expect(insufficient.status).toBe(403);
    expect(await insufficient.json()).toMatchObject({ error: { code: 'insufficient_scope' } });
    expect(graphStore.getServiceNeighborhood).not.toHaveBeenCalled();
    expect(graphStore.upsertService).not.toHaveBeenCalled();
  });

  it('returns a graph error when FalkorDB rejects an authenticated route operation', async () => {
    const baseUrl = await startApi();
    graphStore.getServiceNeighborhood.mockRejectedValueOnce(new Error('connection reset'));
    const response = await fetch(`${baseUrl}/api/v1/graph/services/core/neighborhood`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'graph_error' } });
  });

  it('reports FalkorDB outages and graph projection backlog from readiness', async () => {
    graphStore.checkHealth.mockRejectedValue(new Error('connection refused'));
    const baseUrl = await startApi(true, {
      graphOutbox: {
        enqueue: vi.fn().mockResolvedValue('event-1'),
        checkHealth: vi.fn().mockResolvedValue(7),
      },
    });
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      data: {
        status: 'not_ready',
        components: { graphStore: 'unhealthy', graphProjection: 'healthy' },
        graphProjectionPending: 7,
      },
    });
  });

  it('rebuilds only the authenticated tenant graph with the elevated graph:admin scope', async () => {
    const graphCatalogStore = {
      reconcile: vi.fn().mockResolvedValue({ services: 2, dependencies: 1, incidentLinks: 3 }),
    };
    const baseUrl = await startApi(true, {
      auth0OrgIds: ['org-a', 'org-b'],
      verifyAuth0Token: vi.fn(async (token: string) => ({
        sub: 'auth0|operator',
        organizationId: token === 'no-admin' ? 'org-b' : 'org-a',
        scopes: token === 'no-admin' ? ['graph:write'] : ['graph:admin'],
        roles: [],
      })),
      graphCatalogStore: graphCatalogStore as unknown as RouterConfig['graphCatalogStore'],
    });

    const denied = await fetch(`${baseUrl}/api/v1/graph/reconcile`, {
      method: 'POST',
      headers: { Authorization: 'Bearer no-admin' },
    });
    expect(denied.status).toBe(403);
    expect(graphCatalogStore.reconcile).not.toHaveBeenCalled();

    const response = await fetch(`${baseUrl}/api/v1/graph/reconcile`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { organization: 'org-a', services: 2, dependencies: 1, incidentLinks: 3 },
    });
    expect(graphCatalogStore.reconcile).toHaveBeenCalledWith(graphStore, 'org-a');
  });

  it('queues graph deletions and unlinks in the authenticated organization', async () => {
    const graphCatalogStore = {
      deleteService: vi.fn().mockResolvedValue(true),
      unlinkDependency: vi.fn().mockResolvedValue(true),
      unlinkIncidentFromService: vi.fn().mockResolvedValue(true),
    };
    const baseUrl = await startApi(true, {
      graphCatalogStore: graphCatalogStore as unknown as RouterConfig['graphCatalogStore'],
    });

    const service = await fetch(`${baseUrl}/api/v1/graph/services/api`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-key' },
    });
    const dependency = await fetch(`${baseUrl}/api/v1/graph/dependencies/api/database`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-key' },
    });
    const incidentService = await fetch(
      `${baseUrl}/api/v1/graph/incidents/incident-1/services/api`,
      { method: 'DELETE', headers: { Authorization: 'Bearer test-key' } }
    );

    expect(service.status).toBe(202);
    expect(dependency.status).toBe(202);
    expect(incidentService.status).toBe(202);
    expect(graphCatalogStore.deleteService).toHaveBeenCalledWith('org-test', 'api');
    expect(graphCatalogStore.unlinkDependency).toHaveBeenCalledWith({
      orgId: 'org-test',
      dependentId: 'api',
      dependencyId: 'database',
    });
    expect(graphCatalogStore.unlinkIncidentFromService).toHaveBeenCalledWith({
      orgId: 'org-test',
      incidentId: 'incident-1',
      title: 'incident-1',
      serviceId: 'api',
    });
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
