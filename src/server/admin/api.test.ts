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
});
