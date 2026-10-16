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
  validateLLM?: () => Promise<{ content: string }>,
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

    const api = await fetch(`${base}/api/v1/auth/config`);
    expect(api.headers.get('content-security-policy')).toContain("connect-src 'self';");
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
        token === 'alice-token' ? { sub: 'auth0|alice' } : undefined,
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
    const base = await startApi();
    const headers = { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' };
    const created = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Worker backlog', severity: 'SEV-2' }),
    });
    const incident = ((await created.json()) as { data: { id: string } }).data;
    const planResponse = await fetch(`${base}/api/v1/incidents/${incident.id}/remediations`, {
      method: 'POST',
      headers,
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
      headers,
    });
    expect(blocked.status).toBe(409);
    const approved = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/approval`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ decision: 'approve', reason: 'Reviewed impact and rollback' }),
      }
    );
    expect(approved.status).toBe(200);
    const executed = await fetch(`${base}/api/v1/remediations/${plan.id}/steps/${stepId}/execute`, {
      method: 'POST',
      headers,
    });
    expect(executed.status).toBe(200);
    expect(((await executed.json()) as { data: unknown }).data).toMatchObject({
      executionSucceeded: true,
      verificationSucceeded: true,
      status: 'verified',
    });
    const rollbackBlocked = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/rollback`,
      { method: 'POST', headers }
    );
    expect(rollbackBlocked.status).toBe(409);
    const rollbackApproval = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/rollback-approval`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ decision: 'approve', reason: 'Restore if monitoring regresses' }),
      }
    );
    expect(rollbackApproval.status).toBe(200);
    const rollback = await fetch(
      `${base}/api/v1/remediations/${plan.id}/steps/${stepId}/rollback`,
      { method: 'POST', headers }
    );
    expect(rollback.status).toBe(200);
    expect(((await rollback.json()) as { data: unknown }).data).toMatchObject({
      status: 'rolled_back',
    });
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
