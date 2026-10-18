import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/onboarding', () => ({
  loadServiceConfig: vi.fn(async () => ({
    observability: { datadog: { enabled: true } },
  })),
}));
import { queryMetrics } from './datadog';
import { configure, instantQuery } from './prometheus';

describe('observability request cancellation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forwards the investigation AbortSignal to Datadog fetch', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      return new Response(
        JSON.stringify({
          status: 'ok',
          series: [],
          from_date: 1,
          to_date: 2,
          query: 'avg:test',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const originalApiKey = process.env.DD_API_KEY;
    const originalAppKey = process.env.DD_APP_KEY;
    process.env.DD_API_KEY = 'unit-test-api-key';
    process.env.DD_APP_KEY = 'unit-test-app-key';

    try {
      await expect(queryMetrics('avg:test', 60, 0, signal)).resolves.toMatchObject({
        query: 'avg:test',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      if (originalApiKey === undefined) delete process.env.DD_API_KEY;
      else process.env.DD_API_KEY = originalApiKey;
      if (originalAppKey === undefined) delete process.env.DD_APP_KEY;
      else process.env.DD_APP_KEY = originalAppKey;
    }
  });

  it('forwards the investigation AbortSignal to Prometheus fetch', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      return new Response(
        JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    configure('https://prometheus.example.test');

    await expect(instantQuery('up', undefined, signal)).resolves.toMatchObject({
      resultType: 'vector',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
