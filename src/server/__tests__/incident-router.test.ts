import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { DEFAULT_CONFIG } from '../../utils/config';
import type { IKnowledgeRetriever } from '../../knowledge/retriever/types';
import { IncidentStore } from '../incidents/store';
import { WorkflowStore } from '../workflows/store';
import type { RemediationExecutor } from '../workflows/remediation';
import { createRouter, type RouterConfig } from '../router';

let server: Server | undefined;
let store: IncidentStore | undefined;
let workflowStore: WorkflowStore | undefined;
let dir: string | undefined;
async function startApi(
  config = DEFAULT_CONFIG,
  validateLLM?: (credentialSource?: 'auto' | 'primary' | 'fallback') => Promise<{
    content: string;
    usedFallback?: boolean;
    primaryFailure?: { source: 'primary'; category: string; status?: number };
  }>,
  extras: Partial<RouterConfig> = {}
) {
  dir = mkdtempSync(join(tmpdir(), 'tracemind-api-'));
  store = new IncidentStore(join(dir, 'incidents.sqlite'));
  workflowStore = new WorkflowStore(join(dir, 'incidents.sqlite'));
  const router = createRouter({
    apiKey: 'test-key',
    retriever: { close: () => {} } as unknown as IKnowledgeRetriever,
    mcpServer: { close: () => {} } as never,
    version: 'test',
    config,
    validateLLM,
    ...extras,
    incidentStore: store,
    workflowStore,
    remediationExecutor: {
      execute: vi.fn().mockResolvedValue({ succeeded: true, output: 'action accepted' }),
      verify: vi.fn().mockResolvedValue({ succeeded: true, evidence: 'health is green' }),
      rollback: vi.fn().mockResolvedValue({ succeeded: true, output: 'restored' }),
    } as RemediationExecutor,
  });
  server = createServer(router);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not bound');
  return `http://127.0.0.1:${address.port}`;
}
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve())));
  server = undefined;
  store?.close();
  store = undefined;
  workflowStore?.close();
  workflowStore = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('incident API', () => {
  it('serves the public launch page from the service root with dashboard links', async () => {
    const base = await startApi();
    const home = await fetch(base);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain('Open TraceMind dashboard');

    const style = await fetch(`${base}/launch.css`);
    expect(style.status).toBe(200);
    expect(style.headers.get('content-type')).toContain('text/css');
    const script = await fetch(`${base}/launch.js`);
    expect(script.status).toBe(200);
  });

  it('serves admin bundles with revalidation so browsers do not pin stale auth code', async () => {
    const base = await startApi();
    const html = await fetch(`${base}/admin`);
    expect(html.status).toBe(200);
    expect(html.headers.get('cache-control')).toBe('no-cache');
    expect(await html.text()).toContain('<title>TraceMind · Incident Operations</title>');

    const bundle = await fetch(`${base}/admin/index.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('cache-control')).toBe('no-cache');
    expect(await bundle.text()).toContain('/api/v1/auth/validate');
  });

  it('allows Auth0 token exchange only on admin pages', async () => {
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      auth0Config: {
        domain: 'tenant.example.auth0.com',
        clientId: 'public-client',
        audience: 'https://api.example.test',
        issuer: 'https://tenant.example.auth0.com/',
      },
    });

    const admin = await fetch(`${base}/admin?code=callback-code&state=callback-state`);
    expect(admin.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://tenant.example.auth0.com;"
    );
    expect(admin.headers.get('content-security-policy')).toContain("frame-ancestors 'none';");
    expect(admin.headers.get('content-security-policy')).not.toContain('frame-src');

    const api = await fetch(`${base}/api/v1/auth/config`);
    expect(api.headers.get('content-security-policy')).toContain("connect-src 'self';");
    expect(api.headers.get('content-security-policy')).not.toContain('frame-src');
    expect(api.headers.get('content-security-policy')).not.toContain('tenant.example.auth0.com');
  });

  it('validates dashboard credentials without requiring auth for the public health check', async () => {
    const base = await startApi();
    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      data: {
        status: 'ready',
        components: {
          incidentStore: 'healthy',
          workflowStore: 'healthy',
          graphStore: 'optional_not_configured',
        },
      },
    });
    expect((await fetch(`${base}/api/v1/auth/validate`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/v1/auth/validate`, {
          headers: { Authorization: 'Bearer wrong-key' },
        })
      ).status
    ).toBe(401);
    const valid = await fetch(`${base}/api/v1/auth/validate`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ data: { authenticated: true } });
  });

  it('serves dependency-independent liveness and dependency-aware readiness probes', async () => {
    const verifyAuth0Token = vi.fn().mockRejectedValue(new Error('Auth0 unavailable'));
    const base = await startApi(DEFAULT_CONFIG, undefined, { verifyAuth0Token });

    const live = await fetch(`${base}/livez`, {
      headers: { Authorization: 'Bearer probe-token' },
    });
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ data: { status: 'alive' } });
    const headLive = await fetch(`${base}/livez`, { method: 'HEAD' });
    expect(headLive.status).toBe(200);
    expect(await headLive.text()).toBe('');

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ data: { status: 'ready' } });
    expect(verifyAuth0Token).not.toHaveBeenCalled();
    const headReady = await fetch(`${base}/readyz`, { method: 'HEAD' });
    expect(headReady.status).toBe(200);
    expect(await headReady.text()).toBe('');
  });

  it('marks readiness unhealthy when a configured graph store is unavailable', async () => {
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      graphStore: {
        checkHealth: vi.fn().mockRejectedValue(new Error('graph unavailable')),
      } as never,
    });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      data: {
        status: 'not_ready',
        components: { graphStore: 'unhealthy' },
      },
    });
    const headReady = await fetch(`${base}/readyz`, { method: 'HEAD' });
    expect(headReady.status).toBe(503);
    expect(await headReady.text()).toBe('');
  });

  it('checks graph projection readiness for every configured tenant', async () => {
    const checkHealth = vi.fn(async (orgId?: string) => (orgId === 'org-b' ? 2 : 1));
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      graphOrgId: 'org-a',
      auth0OrgIds: ['org-a', 'org-b'],
      graphCatalogStore: { checkHealth } as never,
    });
    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(200);
    expect(checkHealth.mock.calls.map(([orgId]) => orgId).sort()).toEqual(['org-a', 'org-b']);
    expect(await ready.json()).toMatchObject({ data: { graphProjectionPending: 3 } });
  });

  it('marks PostgreSQL-backed knowledge and vector stores unready when their probes fail', async () => {
    const checkHealth = vi.fn().mockResolvedValue({
      knowledgeStore: false,
      vectorStore: false,
    });
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      databaseDriver: 'postgres',
      retriever: { checkHealth, close: vi.fn() } as unknown as IKnowledgeRetriever,
    });

    const ready = await fetch(`${base}/readyz`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({
      data: {
        status: 'not_ready',
        components: {
          knowledgeStore: 'unhealthy',
          vectorStore: 'unhealthy',
        },
      },
    });
    expect(checkHealth).toHaveBeenCalledOnce();
  });

  it('blocks multi-organization Auth0 from shared retriever and MCP fallbacks', async () => {
    const globalSearch = vi.fn().mockResolvedValue({
      runbooks: [],
      postmortems: [],
      architecture: [],
      knownIssues: [],
    });
    const mcpToolCall = vi.fn();
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      graphOrgId: 'org-a',
      auth0OrgIds: ['org-a', 'org-b'],
      retriever: { search: globalSearch, close: vi.fn() } as unknown as IKnowledgeRetriever,
      mcpServer: {
        close: vi.fn(),
        handleToolCall: mcpToolCall,
      } as never,
      verifyAuth0Token: async (token: string) =>
        token === 'tenant-b'
          ? {
              sub: 'auth0|tenant-b',
              scopes: ['knowledge:read', 'mcp:access'],
              roles: [],
              organizationId: 'org-b',
            }
          : undefined,
    });
    const headers = {
      Authorization: 'Bearer tenant-b',
      'Content-Type': 'application/json',
    };

    const knowledge = await fetch(`${base}/api/v1/knowledge/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: 'tenant private data' }),
    });
    expect(knowledge.status).toBe(503);
    expect(await knowledge.json()).toMatchObject({
      error: { code: 'tenant_retriever_unavailable' },
    });

    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_runbooks', arguments: { query: 'tenant private data' } },
      }),
    });
    expect(mcp.status).toBe(503);
    expect(await mcp.json()).toMatchObject({ error: { code: 'tenant_mcp_unavailable' } });
    expect(globalSearch).not.toHaveBeenCalled();
    expect(mcpToolCall).not.toHaveBeenCalled();
  });

  it('publishes Auth0 browser settings and scopes provider-key operations to verified subjects', async () => {
    const saved = new Map<string, { provider: string; apiKey: string }>();
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      auth0Config: {
        domain: 'tenant.example.auth0.com',
        clientId: 'public-client',
        audience: 'https://api.example.test',
        issuer: 'https://tenant.example.auth0.com/',
      },
      verifyAuth0Token: async (token: string) =>
        token === 'alice-token'
          ? {
              sub: 'auth0|alice',
              scopes: ['settings:keys'],
              roles: [],
              organizationId: 'default',
            }
          : undefined,
      providerKeyStore: {
        getStatus: async (subject: string) =>
          saved.has(subject)
            ? {
                configured: true,
                provider: saved.get(subject)!.provider,
                updatedAt: '2026-10-17T00:00:00.000Z',
              }
            : { configured: false },
        save: async (subject: string, provider: string, apiKey: string) => {
          saved.set(subject, { provider, apiKey });
        },
        delete: async (subject: string) => {
          saved.delete(subject);
        },
        getDecrypted: async (subject: string) => saved.get(subject),
      },
    });
    expect(await (await fetch(`${base}/api/v1/auth/config`)).json()).toMatchObject({
      data: { enabled: true, clientId: 'public-client' },
    });
    expect(
      (
        await fetch(`${base}/api/v1/settings/provider-key`, {
          headers: { Authorization: 'Bearer test-key' },
        })
      ).status
    ).toBe(401);
    const headers = { Authorization: 'Bearer alice-token', 'Content-Type': 'application/json' };
    const put = await fetch(`${base}/api/v1/settings/provider-key`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ provider: 'openai', apiKey: 'secret-provider-key' }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain('secret-provider-key');
    expect(saved.get('auth0|alice')?.apiKey).toBe('secret-provider-key');
    expect(
      (
        await fetch(`${base}/api/v1/settings/provider-key`, {
          headers: { Authorization: 'Bearer alice-token' },
        })
      ).status
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/api/v1/settings/provider-key`, {
          headers: { Authorization: 'Bearer stranger-token' },
        })
      ).status
    ).toBe(401);
  });

  it('enforces Auth0 scopes and rejects organizations outside the configured allowlist', async () => {
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      auth0OrgIds: ['default', 'org-b'],
      verifyAuth0Token: async (token: string) => {
        if (token === 'read-only') {
          return {
            sub: 'auth0|reader',
            scopes: ['incidents:read'],
            roles: [],
            organizationId: 'default',
          };
        }
        if (token === 'write-unlisted-org') {
          return {
            sub: 'auth0|foreign',
            scopes: ['incidents:read', 'incidents:write'],
            roles: [],
            organizationId: 'not-allowed',
          };
        }
        return undefined;
      },
    });

    const readOnly = { Authorization: 'Bearer read-only' };
    expect((await fetch(`${base}/api/v1/incidents`, { headers: readOnly })).status).toBe(200);
    expect(
      (
        await fetch(`${base}/api/v1/incidents`, {
          method: 'POST',
          headers: { ...readOnly, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Denied write', severity: 'SEV-3' }),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/api/v1/incidents`, {
          headers: { Authorization: 'Bearer write-unlisted-org' },
        })
      ).status
    ).toBe(403);
  });

  it('lets a newly admitted Auth0 organization member initialize the dashboard before RBAC assignment', async () => {
    const tenantRetriever = {
      close: () => {},
      getDocumentCountsByType: async () => ({
        runbook: 0,
        postmortem: 0,
        architecture: 0,
        'known-issue': 0,
      }),
      getAllDocuments: async () => [],
    } as unknown as IKnowledgeRetriever;
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      retriever: tenantRetriever,
      retrieverForTenant: async (tenantId) => {
        expect(tenantId).toBe('org-new');
        return tenantRetriever;
      },
      auth0OrgIds: ['org-new'],
      verifyAuth0Token: async (token) =>
        token === 'new-member'
          ? { sub: 'google-oauth2|new-member', organizationId: 'org-new', scopes: [], roles: [] }
          : undefined,
    });
    const auth = { Authorization: 'Bearer new-member', 'Content-Type': 'application/json' };

    expect((await fetch(`${base}/api/v1/knowledge/stats`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/knowledge/services`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${base}/api/v1/incidents`, { headers: auth })).status).toBe(200);

    const mutation = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ title: 'must require incidents:write', severity: 'SEV-3' }),
    });
    expect(mutation.status).toBe(403);
    expect(await mutation.json()).toMatchObject({ error: { code: 'insufficient_scope' } });

    for (const path of [
      '/api/v1/incidents/not-authorized',
      '/api/v1/incidents/not-authorized/events',
      '/api/v1/knowledge/documents',
      '/api/v1/knowledge/documents/not-authorized',
      '/api/v1/knowledge/sources',
    ]) {
      const response = await fetch(`${base}${path}`, { headers: auth });
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'insufficient_scope' } });
    }
  });

  it('isolates incidents, remediation proposals, and evaluations by Auth0 organization', async () => {
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      auth0OrgIds: ['org-a', 'org-b'],
      verifyAuth0Token: async (token: string) => {
        const tenant = token.startsWith('tenant-a')
          ? 'org-a'
          : token.startsWith('tenant-b')
            ? 'org-b'
            : undefined;
        if (!tenant) return undefined;
        return {
          sub: `auth0|${token}`,
          scopes: [
            'incidents:read',
            'incidents:write',
            'remediations:propose',
            'remediations:read',
            'evaluations:read',
            'evaluations:write',
          ],
          roles: [],
          organizationId: tenant,
        };
      },
    });
    const auth = (token: string) => ({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
    const created = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: auth('tenant-a-user'),
      body: JSON.stringify({ title: 'Tenant A incident', severity: 'SEV-2' }),
    });
    expect(created.status).toBe(201);
    const incidentId = ((await created.json()) as { data: { id: string } }).data.id;

    expect(
      await (await fetch(`${base}/api/v1/incidents`, { headers: auth('tenant-b-user') })).json()
    ).toMatchObject({ data: [] });
    expect(
      (await fetch(`${base}/api/v1/incidents/${incidentId}`, { headers: auth('tenant-b-user') }))
        .status
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/api/v1/incidents/${incidentId}/events`, {
          headers: auth('tenant-b-user'),
        })
      ).status
    ).toBe(404);

    const deniedProposal = await fetch(`${base}/api/v1/incidents/${incidentId}/remediations`, {
      method: 'POST',
      headers: auth('tenant-b-user'),
      body: JSON.stringify({
        title: 'Cross-tenant plan',
        steps: [{ actionId: 'a', postCheckId: 'b', rollbackActionId: 'c', description: 'd' }],
      }),
    });
    expect(deniedProposal.status).toBe(404);

    const evaluation = {
      dataset: 'shared-name',
      caseId: 'same-case',
      groundTruthRootCause: 'db',
      relevantEvidenceIds: ['e'],
      expectedFixOutcome: 'succeeded',
      baseline: { rootCause: 'db', evidenceIds: ['e'], fixOutcome: 'succeeded' },
      graph: { rootCause: 'db', evidenceIds: ['e'], fixOutcome: 'succeeded' },
    };
    expect(
      (
        await fetch(`${base}/api/v1/evaluations/cases`, {
          method: 'POST',
          headers: auth('tenant-a-user'),
          body: JSON.stringify(evaluation),
        })
      ).status
    ).toBe(201);
    expect(
      (
        await fetch(`${base}/api/v1/evaluations/cases`, {
          method: 'POST',
          headers: auth('tenant-b-user'),
          body: JSON.stringify(evaluation),
        })
      ).status
    ).toBe(201);
    for (const token of ['tenant-a-user', 'tenant-b-user']) {
      const cases = await fetch(`${base}/api/v1/evaluations/cases?dataset=shared-name`, {
        headers: auth(token),
      });
      expect(((await cases.json()) as { data: unknown[] }).data).toHaveLength(1);
    }
  });

  it('requires admin authentication before testing the configured LLM', async () => {
    const validateLLM = vi
      .fn()
      .mockResolvedValue({ content: 'TraceMind model connection successful.' });
    const base = await startApi(DEFAULT_CONFIG, validateLLM);

    const rejected = await fetch(`${base}/api/v1/llm/validate`, { method: 'POST' });
    expect(rejected.status).toBe(401);
    expect(validateLLM).not.toHaveBeenCalled();

    const accepted = await fetch(`${base}/api/v1/llm/validate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      data: {
        status: 'connected',
        response: 'TraceMind model connection successful.',
      },
    });
    expect(validateLLM).toHaveBeenCalledOnce();
  });

  it('returns only sanitized primary failure metadata when fallback validates successfully', async () => {
    const validateLLM = vi.fn().mockImplementation((credentialSource = 'auto') =>
      Promise.resolve({
        content: 'TraceMind model connection successful.',
        usedFallback: true,
        credentialSource: credentialSource === 'auto' ? 'fallback' : credentialSource,
        primaryFailure: { source: 'primary', category: 'unauthorized', status: 401 },
      })
    );
    const base = await startApi(DEFAULT_CONFIG, validateLLM);
    const response = await fetch(`${base}/api/v1/llm/validate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        status: 'connected',
        response: 'TraceMind model connection successful.',
        usedFallback: true,
        credentialSource: 'fallback',
        primaryFailure: { source: 'primary', category: 'unauthorized', status: 401 },
      },
    });
  });

  it('passes an explicit credential source through the protected validation route', async () => {
    const validateLLM = vi.fn().mockResolvedValue({
      content: 'primary response',
      usedFallback: false,
      credentialSource: 'primary',
    });
    const base = await startApi(DEFAULT_CONFIG, validateLLM);
    const response = await fetch(`${base}/api/v1/llm/validate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ credentialSource: 'primary' }),
    });

    expect(response.status).toBe(200);
    expect(validateLLM).toHaveBeenCalledExactlyOnceWith('primary');
    expect(await response.json()).toMatchObject({
      data: { status: 'connected', credentialSource: 'primary', usedFallback: false },
    });
  });

  it('rejects unknown validation modes without calling a provider', async () => {
    const validateLLM = vi.fn();
    const base = await startApi(DEFAULT_CONFIG, validateLLM);
    const response = await fetch(`${base}/api/v1/llm/validate`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ credentialSource: 'primary-and-fallback' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'bad_request',
        message: 'credentialSource must be auto, primary, or fallback',
      },
    });
    expect(validateLLM).not.toHaveBeenCalled();
  });

  it('does not return provider exception details from LLM validation', async () => {
    const validateLLM = vi.fn().mockRejectedValue(new Error('unauthorized; token=provider-secret'));
    const base = await startApi(DEFAULT_CONFIG, validateLLM);
    const response = await fetch(`${base}/api/v1/llm/validate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
    });

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('llm_validation_failed');
    expect(body).not.toContain('provider-secret');
  });

  it('blocks traversal outside the admin bundle and caps request bodies', async () => {
    const base = await startApi();
    const traversal = await fetch(`${base}/admin/%2e%2e%2fpackage.json`);
    expect(traversal.status).toBe(404);
    expect(await traversal.text()).not.toContain('@runbook-agent/runbook');

    const tooLarge = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(1_048_600), severity: 'SEV-1' }),
    });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('enforces configured CORS allowlists and provides security headers', async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.server.cors = { enabled: true, origins: ['https://console.example.test'] };
    const base = await startApi(config);
    const allowed = await fetch(`${base}/api/v1/auth/validate`, {
      headers: { Origin: 'https://console.example.test', Authorization: 'Bearer test-key' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://console.example.test');
    expect(allowed.headers.get('x-content-type-options')).toBe('nosniff');
    expect(allowed.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

    const rejected = await fetch(`${base}/api/v1/auth/validate`, {
      headers: { Origin: 'https://other.example.test', Authorization: 'Bearer test-key' },
    });
    expect(rejected.status).toBe(403);
  });

  it('requires auth, persists incident CRUD and exposes audit timeline', async () => {
    const base = await startApi();
    expect((await fetch(`${base}/api/v1/incidents`)).status).toBe(401);
    const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
    const created = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Latency spike', severity: 'SEV-1' }),
    });
    expect(created.status).toBe(201);
    const incident = ((await created.json()) as { data: { id: string } }).data;
    const invalidTransition = await fetch(`${base}/api/v1/incidents/${incident.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ status: 'mitigated' }),
    });
    expect(invalidTransition.status).toBe(409);
    expect(await invalidTransition.json()).toMatchObject({
      error: { code: 'invalid_transition' },
    });
    const changed = await fetch(`${base}/api/v1/incidents/${incident.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ assignee: 'SRE', status: 'investigating' }),
    });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { data: unknown }).data).toMatchObject({
      assignee: 'SRE',
      status: 'investigating',
    });
    const events = await fetch(`${base}/api/v1/incidents/${incident.id}/events`, { headers });
    expect(
      ((await events.json()) as { data: { action: string }[] }).data.map((e) => e.action)
    ).toContain('status_changed');
  });

  it('validates create and update fields', async () => {
    const base = await startApi();
    const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
    const invalid = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: '', severity: 'urgent' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('enforces approval and records real post-check results for remediation execution', async () => {
    const identities = {
      proposer: {
        sub: 'proposer',
        scopes: ['incidents:write', 'remediations:propose'],
        roles: [],
        organizationId: 'default',
      },
      approver: {
        sub: 'approver',
        scopes: ['remediations:approve'],
        roles: [],
        organizationId: 'default',
      },
      executor: {
        sub: 'executor',
        scopes: ['remediations:execute'],
        roles: [],
        organizationId: 'default',
      },
      rollbackApprover: {
        sub: 'rollback-approver',
        scopes: ['remediations:approve'],
        roles: [],
        organizationId: 'default',
      },
      rollbackExecutor: {
        sub: 'rollback-executor',
        scopes: ['remediations:rollback'],
        roles: [],
        organizationId: 'default',
      },
      reconciler: {
        sub: 'incident-responder',
        scopes: ['remediations:reconcile'],
        roles: [],
        organizationId: 'default',
      },
      readOnlyReconciler: {
        sub: 'reader',
        scopes: ['remediations:read'],
        roles: [],
        organizationId: 'default',
      },
    };
    const base = await startApi(DEFAULT_CONFIG, undefined, {
      auth0OrgIds: ['default'],
      verifyAuth0Token: async (token) => identities[token as keyof typeof identities],
    });
    const auth0Headers = (token: keyof typeof identities) => ({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
    const created = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: auth0Headers('proposer'),
      body: JSON.stringify({ title: 'Worker backlog', severity: 'SEV-2' }),
    });
    const incident = ((await created.json()) as { data: { id: string } }).data;
    const planResponse = await fetch(`${base}/api/v1/incidents/${incident.id}/remediations`, {
      method: 'POST',
      headers: auth0Headers('proposer'),
      body: JSON.stringify({
        title: 'Recover worker',
        steps: [
          {
            actionId: 'worker.restart',
            postCheckId: 'worker.health',
            rollbackActionId: 'worker.restore',
            description: 'Restart worker',
          },
        ],
      }),
    });
    expect(planResponse.status).toBe(201);
    const plan = ((await planResponse.json()) as { data: { id: string; steps: { id: string }[] } })
      .data;
    const stepId = plan.steps[0].id;
    const blocked = await fetch(`${base}/api/v1/remediations/${plan.id}/steps/${stepId}/execute`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    });
    expect(blocked.status).toBe(409);
    const approved = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/approval`,
      {
        method: 'POST',
        headers: auth0Headers('approver'),
        body: JSON.stringify({ decision: 'approve', reason: 'Reviewed impact and rollback' }),
      }
    );
    expect(approved.status).toBe(200);
    const executed = await fetch(`${base}/api/v1/remediations/${plan.id}/steps/${stepId}/execute`, {
      method: 'POST',
      headers: auth0Headers('executor'),
    });
    expect(executed.status).toBe(200);
    expect(((await executed.json()) as { data: unknown }).data).toMatchObject({
      executionSucceeded: true,
      verificationSucceeded: true,
      status: 'verified',
    });
    const rollbackBlocked = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/rollback`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
      }
    );
    expect(rollbackBlocked.status).toBe(409);
    const rollbackApproval = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/rollback-approval`,
      {
        method: 'POST',
        headers: auth0Headers('rollbackApprover'),
        body: JSON.stringify({ decision: 'approve', reason: 'Restore if monitoring regresses' }),
      }
    );
    expect(rollbackApproval.status).toBe(200);
    const rollback = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/rollback`,
      { method: 'POST', headers: auth0Headers('rollbackExecutor') }
    );
    expect(rollback.status).toBe(200);
    expect(((await rollback.json()) as { data: unknown }).data).toMatchObject({
      status: 'rolled_back',
    });

    const ambiguous = workflowStore!.createPlan(
      incident.id,
      'Reconcile uncertain broker outcome',
      [
        {
          actionId: 'worker.restart',
          postCheckId: 'worker.health',
          rollbackActionId: 'worker.restore',
          description: 'Ambiguous action',
        },
      ],
      'proposer'
    );
    const ambiguousStep = ambiguous.steps[0];
    workflowStore!.decide(
      ambiguous.id,
      ambiguousStep.id,
      'approve',
      'approver',
      'Approved for test'
    );
    workflowStore!.beginExecution(ambiguous.id, ambiguousStep.id, 'executor', 'ambiguous-lease');
    workflowStore!.reconcileExpiredLeases('system', new Date(Date.now() + 120_000), 'default');
    const reconcileUrl = `${base}/api/v1/remediations/${ambiguous.id}/steps/${ambiguousStep.id}/reconcile`;
    expect(
      (
        await fetch(reconcileUrl, {
          method: 'POST',
          headers: auth0Headers('readOnlyReconciler'),
          body: JSON.stringify({
            operation: 'execute',
            succeeded: true,
            evidence: 'broker key checked',
          }),
        })
      ).status
    ).toBe(403);
    const reconciled = await fetch(reconcileUrl, {
      method: 'POST',
      headers: auth0Headers('reconciler'),
      body: JSON.stringify({
        operation: 'execute',
        succeeded: true,
        evidence: 'Broker idempotency key and independent post-check confirmed action',
      }),
    });
    expect(reconciled.status).toBe(200);
    expect(
      (
        (await reconciled.json()) as {
          data: { steps: { status: string }[]; events: { action: string; actor: string }[] };
        }
      ).data
    ).toMatchObject({
      steps: [{ status: 'execution_succeeded' }],
      events: expect.arrayContaining([
        expect.objectContaining({
          action: 'execute_reconciled',
          actor: 'auth0:incident-responder',
        }),
      ]),
    });

    const uncertainCheck = workflowStore!.createPlan(
      incident.id,
      'Unknown post-check',
      [
        {
          actionId: 'worker.restart',
          postCheckId: 'worker.health',
          rollbackActionId: 'worker.restore',
          description: 'Check outcome lost',
        },
      ],
      'proposer'
    );
    const checkStep = uncertainCheck.steps[0];
    workflowStore!.decide(uncertainCheck.id, checkStep.id, 'approve', 'approver', 'Approved');
    workflowStore!.beginExecution(
      uncertainCheck.id,
      checkStep.id,
      'executor',
      'verify-route-lease'
    );
    workflowStore!.setExecution(
      uncertainCheck.id,
      checkStep.id,
      'verification_unknown',
      { succeeded: true, output: 'action applied' },
      { succeeded: false, error: 'Verification outcome unknown: timeout' },
      'executor',
      'verify-route-lease'
    );
    const verifyReconciled = await fetch(
      `${base}/api/v1/remediations/${uncertainCheck.id}/steps/${checkStep.id}/reconcile`,
      {
        method: 'POST',
        headers: auth0Headers('reconciler'),
        body: JSON.stringify({
          operation: 'verify',
          succeeded: true,
          evidence: 'Independent health check succeeded',
        }),
      }
    );
    expect(verifyReconciled.status).toBe(200);
    expect(
      ((await verifyReconciled.json()) as { data: { steps: { status: string }[] } }).data.steps[0]
        .status
    ).toBe('verified');
  });

  it('stores paired known-case evaluation results and serves aggregate analytics', async () => {
    const base = await startApi();
    const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
    const response = await fetch(`${base}/api/v1/evaluations/cases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        dataset: 'fixture-v1',
        caseId: 'case-1',
        groundTruthRootCause: 'db-pool',
        relevantEvidenceIds: ['metric', 'log'],
        expectedFixOutcome: 'succeeded',
        baseline: { rootCause: 'timeout', evidenceIds: ['metric'], fixOutcome: 'failed' },
        graph: { rootCause: 'db-pool', evidenceIds: ['metric', 'log'], fixOutcome: 'succeeded' },
      }),
    });
    expect(response.status).toBe(201);
    const analytics = await fetch(`${base}/api/v1/evaluations/analytics?dataset=fixture-v1`, {
      headers,
    });
    expect(((await analytics.json()) as { data: unknown }).data).toMatchObject({
      cases: 1,
      baseline: { rootCauseAccuracy: 0 },
      graph: { rootCauseAccuracy: 1, retrievalQuality: 1 },
    });
  });
});
