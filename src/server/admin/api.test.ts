import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from './api';

describe('AdminApi route authorization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the llm:validate scope and sends the resulting bearer token', async () => {
    const credential = vi.fn(async (_scope?: string) => 'validation-access-token');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              status: 'connected',
              provider: 'nvidia',
              model: 'test-model',
              response: 'ok',
              checkedAt: '2026-10-17T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new AdminApi(credential).validateLLM();

    expect(credential).toHaveBeenCalledExactlyOnceWith('llm:validate');
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/llm/validate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer validation-access-token',
        }),
      })
    );
    expect(result).toMatchObject({ status: 'connected', provider: 'nvidia', model: 'test-model' });
  });

  it('preserves sanitized primary failure diagnostics from a successful fallback response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                status: 'connected',
                provider: 'openai-compatible',
                model: 'test-model',
                response: 'TraceMind model connection successful.',
                checkedAt: '2026-10-17T00:00:00.000Z',
                usedFallback: true,
                primaryFailure: { source: 'primary', category: 'unauthorized', status: 401 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );

    await expect(new AdminApi('token').validateLLM()).resolves.toMatchObject({
      usedFallback: true,
      primaryFailure: { category: 'unauthorized', status: 401 },
    });
  });

  it('sends the requested key source for isolated validation', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              status: 'connected',
              provider: 'openai-compatible',
              model: 'test-model',
              response: 'primary response',
              checkedAt: '2026-10-17T00:00:00.000Z',
              credentialSource: 'primary',
              usedFallback: false,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await new AdminApi('token').validateLLM('primary');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/llm/validate',
      expect.objectContaining({ body: JSON.stringify({ credentialSource: 'primary' }) })
    );
    expect(result.credentialSource).toBe('primary');
  });

  it('does not request a protected scope for public health', async () => {
    const credential = vi.fn(async (_scope?: string) => 'dashboard-access-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { status: 'ok', version: 'test', uptime: 1 } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    await new AdminApi(credential).getHealth();

    expect(credential).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each([
    ['incident read', (api: AdminApi) => api.getIncidents(), 'incidents:read'],
    [
      'incident write',
      (api: AdminApi) => api.createIncident({ title: 'Checkout errors', severity: 'SEV-3' }),
      'incidents:write',
    ],
    ['graph evidence read', (api: AdminApi) => api.getEvidencePaths('incident-1'), 'graph:read'],
    ['knowledge read', (api: AdminApi) => api.getStats(), 'knowledge:read'],
    [
      'POST knowledge search read',
      (api: AdminApi) => api.search('payment errors'),
      'knowledge:read',
    ],
    ['knowledge write', (api: AdminApi) => api.sync(), 'knowledge:write'],
    ['provider-key settings', (api: AdminApi) => api.getProviderKeyStatus(), 'settings:keys'],
    ['remediation read', (api: AdminApi) => api.getRemediation('plan-1'), 'remediations:read'],
    [
      'remediation approval',
      (api: AdminApi) => api.remediationDecision('plan-1', 'step-1', 'approve', 'reviewed'),
      'remediations:approve',
    ],
    [
      'remediation execution',
      (api: AdminApi) => api.executeRemediation('plan-1', 'step-1'),
      'remediations:execute',
    ],
    ['evaluation read', (api: AdminApi) => api.getEvaluationAnalytics('demo'), 'evaluations:read'],
  ])('requests only the %s scope', async (_label, invoke, scope) => {
    const credential = vi.fn(async (_scope?: string) => 'scoped-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    await invoke(new AdminApi(credential));

    expect(credential).toHaveBeenCalledExactlyOnceWith(scope);
  });

  it.each([
    [
      'missing permission',
      'insufficient_scope',
      { code: 'insufficient_scope', message: 'Required permission: incidents:read' },
      'Your TraceMind organization role is missing incidents:read.',
    ],
    [
      'missing organization',
      'tenant_required',
      { code: 'tenant_required', message: 'Auth0 token must include an organization claim' },
      'This sign-in is not associated with a TraceMind organization.',
    ],
    [
      'organization not enabled',
      'tenant_forbidden',
      { code: 'tenant_forbidden', message: 'Token organization is not enabled for this service' },
      'This TraceMind organization is not enabled for this service.',
    ],
  ])('explains a %s response in dashboard language', async (_label, _code, error, message) => {
    const credential = vi.fn(async (_scope?: string) => 'scoped-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
      )
    );

    await expect(new AdminApi(credential).getIncidents()).rejects.toThrow(message);
    expect(credential).toHaveBeenCalledExactlyOnceWith('incidents:read');
  });

  it('explains when the validation route returns an HTML page instead of JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<!doctype html><html><body>Not found</body></html>', {
            status: 404,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
      )
    );

    await expect(new AdminApi('token').validateLLM()).rejects.toThrow(
      'TraceMind API /api/v1/llm/validate returned a non-JSON response (HTTP 404, text/html). Check that the deployed API route is available and sign in again if needed.'
    );
  });

  it('explains when an Auth0 redirect ends in an HTML response', async () => {
    const response = new Response('<!doctype html><html><body>Login</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );

    await expect(new AdminApi('expired-token').validateLLM()).rejects.toThrow(
      'The request was redirected, which can happen when the API route is unavailable or the session is no longer valid.'
    );
  });
});
