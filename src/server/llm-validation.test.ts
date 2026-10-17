import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createLLMClient } = vi.hoisted(() => ({ createLLMClient: vi.fn() }));
vi.mock('../model/llm', () => ({ createLLMClient }));

import { DEFAULT_CONFIG } from '../utils/config';
import {
  classifyLLMProviderFailure,
  LLMValidationError,
  validateLLMProvider,
} from './llm-validation';

describe('LLM validation fallback', () => {
  afterEach(() => {
    delete process.env.TRACEMIND_LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.TRACEMIND_LLM_FALLBACK_API_KEY;
  });

  beforeEach(() => {
    createLLMClient.mockReset();
    vi.unstubAllGlobals();
  });

  it('retries once with the fallback key when the primary provider call fails', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient
      .mockReturnValueOnce({ chat: vi.fn().mockRejectedValue(new Error('primary unavailable')) })
      .mockReturnValueOnce({
        chat: vi.fn().mockResolvedValue({ content: 'fallback response', toolCalls: [] }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toEqual({
      content: 'fallback response',
      usedFallback: true,
    });
    expect(createLLMClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ apiKey: 'primary-test-key' })
    );
    expect(createLLMClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ apiKey: 'fallback-test-key' })
    );
  });

  it('retries with fallback when the primary responds with empty content', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient
      .mockReturnValueOnce({ chat: vi.fn().mockResolvedValue({ content: '   ', toolCalls: [] }) })
      .mockReturnValueOnce({
        chat: vi.fn().mockResolvedValue({ content: 'fallback response', toolCalls: [] }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toEqual({
      content: 'fallback response',
      usedFallback: true,
    });
    expect(createLLMClient).toHaveBeenCalledTimes(2);
  });

  it('reports empty responses from both keys as safe attempt diagnostics', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ content: '', toolCalls: [] }),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).rejects.toMatchObject({
      name: 'LLMValidationError',
      attempts: [
        { source: 'primary', category: 'empty_response' },
        { source: 'fallback', category: 'empty_response' },
      ],
      message: 'Provider validation failed. Primary: empty response; Fallback: empty response.',
    });
    expect(createLLMClient).toHaveBeenCalledTimes(2);
  });

  it('does not retry with a missing or duplicate fallback key', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'primary-test-key';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).rejects.toMatchObject({
      name: 'LLMValidationError',
      attempts: [{ source: 'primary', category: 'unknown' }],
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'upstream_http'],
  ] as const)('classifies HTTP %s without exposing provider error details', (status, category) => {
    const failure = classifyLLMProviderFailure(
      new Error(`LLM API error (provider/model): ${status} private response body`),
      'primary'
    );

    expect(failure).toEqual({ source: 'primary', category, status });
  });

  it.each([
    ['request timed out', 'timeout'],
    ['Request was aborted', 'timeout'],
    ['fetch failed: private host detail', 'network'],
    ['ECONNRESET private socket detail', 'network'],
  ] as const)('classifies %s as %s without returning raw text', (message, category) => {
    expect(classifyLLMProviderFailure(new Error(message), 'primary')).toEqual({
      source: 'primary',
      category,
    });
  });

  it('reports safe diagnostics for both a failed primary and failed fallback', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient
      .mockReturnValueOnce({
        chat: vi
          .fn()
          .mockRejectedValue(new Error('LLM API error (provider/model): 401 secret-primary')),
      })
      .mockReturnValueOnce({
        chat: vi
          .fn()
          .mockRejectedValue(new Error('LLM API error (provider/model): 429 secret-fallback')),
      });

    const failure = validateLLMProvider(DEFAULT_CONFIG);
    await expect(failure).rejects.toBeInstanceOf(LLMValidationError);
    await expect(failure).rejects.toMatchObject({
      attempts: [
        { source: 'primary', category: 'unauthorized', status: 401 },
        { source: 'fallback', category: 'rate_limited', status: 429 },
      ],
      message:
        'Provider validation failed. Primary: unauthorized (HTTP 401); Fallback: rate limited (HTTP 429).',
    });
    await expect(failure).rejects.not.toThrow(/secret-primary|secret-fallback/);
  });

  it('reports a primary success without attempting the fallback', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ content: 'primary response', toolCalls: [] }),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toEqual({
      content: 'primary response',
      usedFallback: false,
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
  });

  it('prefers the deployed environment primary key over a stale config-file key', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'rotated-primary-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ content: 'primary response', toolCalls: [] }),
    });

    const configWithStaleKey = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, apiKey: 'stale-config-key' },
    };
    await expect(validateLLMProvider(configWithStaleKey)).resolves.toMatchObject({
      content: 'primary response',
      usedFallback: false,
    });
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'rotated-primary-key' })
    );
  });

  it('uses the fallback environment key when the primary key is absent', async () => {
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient
      .mockReturnValueOnce({ chat: vi.fn().mockRejectedValue(new Error('primary unavailable')) })
      .mockReturnValueOnce({
        chat: vi.fn().mockResolvedValue({ content: 'fallback response', toolCalls: [] }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toMatchObject({
      content: 'fallback response',
      usedFallback: true,
    });
    expect(createLLMClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ apiKey: 'fallback-test-key' })
    );
  });

  it('uses the non-streaming OpenAI-compatible contract for hosted model validation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'TraceMind model connection successful.' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const compatibleConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        provider: 'openai-compatible' as const,
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        apiBaseUrl: 'https://integrate.api.nvidia.com/v1/',
      },
    };

    await expect(
      validateLLMProvider(compatibleConfig, { TRACEMIND_LLM_API_KEY: 'primary-test-key' })
    ).resolves.toEqual({
      content: 'TraceMind model connection successful.',
      usedFallback: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://integrate.api.nvidia.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer primary-test-key' }),
        body: expect.stringContaining('"stream":false'),
      })
    );
    expect(createLLMClient).not.toHaveBeenCalled();
  });

  it('retries the compatible endpoint with fallback after an empty primary answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const compatibleConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        provider: 'openai-compatible' as const,
        model: 'test-model',
        apiBaseUrl: 'https://provider.example/v1',
      },
    };

    await expect(
      validateLLMProvider(compatibleConfig, {
        TRACEMIND_LLM_API_KEY: 'primary-test-key',
        TRACEMIND_LLM_FALLBACK_API_KEY: 'fallback-test-key',
      })
    ).resolves.toEqual({ content: 'fallback answer', usedFallback: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer fallback-test-key' }),
      })
    );
  });

  it('reports compatible HTTP status without leaking provider response bodies', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('private provider details', { status: 401 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const compatibleConfig = {
      ...DEFAULT_CONFIG,
      llm: {
        ...DEFAULT_CONFIG.llm,
        provider: 'openai-compatible' as const,
        model: 'test-model',
        apiBaseUrl: 'https://provider.example/v1',
      },
    };

    await expect(
      validateLLMProvider(compatibleConfig, { TRACEMIND_LLM_API_KEY: 'primary-test-key' })
    ).rejects.toMatchObject({
      attempts: [{ source: 'primary', category: 'unauthorized', status: 401 }],
    });
    await expect(
      validateLLMProvider(compatibleConfig, { TRACEMIND_LLM_API_KEY: 'primary-test-key' })
    ).rejects.not.toThrow(/private provider details/);
  });
});
