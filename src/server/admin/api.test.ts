import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminApi } from './api';

describe('AdminApi LLM validation authorization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requests the llm:validate scope and sends the resulting bearer token', async () => {
    const credential = vi.fn(async (_scope?: string) => 'validation-access-token');
    const fetchMock = vi.fn(async () =>
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
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
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
      }),
    );
    expect(result).toMatchObject({ status: 'connected', provider: 'nvidia', model: 'test-model' });
  });

  it('does not request the validation-only scope for unrelated API calls', async () => {
    const credential = vi.fn(async (_scope?: string) => 'dashboard-access-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { status: 'ok', version: 'test', uptime: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await new AdminApi(credential).getHealth();

    expect(credential).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('explains when the validation route returns an HTML page instead of JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response('<!doctype html><html><body>Not found</body></html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      ),
    );

    await expect(new AdminApi('token').validateLLM()).rejects.toThrow(
      'TraceMind API /api/v1/llm/validate returned a non-JSON response (HTTP 404, text/html). Check that the deployed API route is available and sign in again if needed.',
    );
  });

  it('explains when an Auth0 redirect ends in an HTML response', async () => {
    const response = new Response('<!doctype html><html><body>Login</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    vi.stubGlobal('fetch', vi.fn(async () => response));

    await expect(new AdminApi('expired-token').validateLLM()).rejects.toThrow(
      'The request was redirected, which can happen when the API route is unavailable or the session is no longer valid.',
    );
  });
});
