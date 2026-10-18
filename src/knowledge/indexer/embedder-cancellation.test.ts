import { afterEach, describe, expect, it, vi } from 'vitest';
import { configure, embedText } from './embedder';

describe('embedding request cancellation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards AbortSignal to the configured embedding HTTP request', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2], index: 0 }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    configure('unit-test-key');

    await expect(embedText(`sanitized test ${Date.now()}`, signal)).resolves.toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
