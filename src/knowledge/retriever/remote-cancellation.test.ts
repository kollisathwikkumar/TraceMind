import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteKnowledgeRetriever } from './remote';

describe('remote retriever cancellation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the signal to the HTTP fetch for hosted retrieval', async () => {
    const signal = new AbortController().signal;
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(signal);
      return new Response(
        JSON.stringify({
          data: {
            runbooks: [],
            postmortems: [],
            architecture: [],
            knownIssues: [],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const retriever = new RemoteKnowledgeRetriever(
      'https://tracemind.example.test',
      'unit-test-token'
    );
    await expect(retriever.search('sanitized query', { signal })).resolves.toMatchObject({
      runbooks: [],
      postmortems: [],
      architecture: [],
      knownIssues: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
