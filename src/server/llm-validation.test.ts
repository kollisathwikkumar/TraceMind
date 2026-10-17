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
      .mockReturnValueOnce({
        chat: vi
          .fn()
          .mockRejectedValue(new Error('LLM API error (provider/model): 401 secret-primary')),
      })
      .mockReturnValueOnce({
        chat: vi
          .fn()
          .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toEqual({
      content: 'TraceMind model connection successful.',
      usedFallback: true,
      credentialSource: 'fallback',
      primaryFailure: { source: 'primary', category: 'unauthorized', status: 401 },
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
        chat: vi
          .fn()
          .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toEqual({
      content: 'TraceMind model connection successful.',
      usedFallback: true,
      credentialSource: 'fallback',
      primaryFailure: { source: 'primary', category: 'empty_response' },
    });
    expect(createLLMClient).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unrelated response as a successful validation', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient
      .mockReturnValueOnce({
        chat: vi
          .fn()
          .mockResolvedValue({ content: 'I am thinking about this request.', toolCalls: [] }),
      })
      .mockReturnValueOnce({
        chat: vi.fn().mockResolvedValue({
          content: 'TraceMind model connection successful.',
          toolCalls: [],
        }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toMatchObject({
      content: 'TraceMind model connection successful.',
      usedFallback: true,
      primaryFailure: { source: 'primary', category: 'unexpected_response' },
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
      chat: vi
        .fn()
        .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toEqual({
      content: 'TraceMind model connection successful.',
      usedFallback: false,
      credentialSource: 'primary',
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
  });

  it('prefers the deployed environment primary key over a stale config-file key', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'rotated-primary-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient.mockReturnValue({
      chat: vi
        .fn()
        .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
    });

    const configWithStaleKey = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, apiKey: 'stale-config-key' },
    };
    await expect(validateLLMProvider(configWithStaleKey)).resolves.toMatchObject({
      content: 'TraceMind model connection successful.',
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
        chat: vi
          .fn()
          .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toMatchObject({
      content: 'TraceMind model connection successful.',
      usedFallback: true,
    });
    expect(createLLMClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ apiKey: 'fallback-test-key' })
    );
  });

  it('allows enough reasoning output for hosted OpenAI-compatible providers', async () => {
    createLLMClient.mockReturnValue({
      chat: vi
        .fn()
        .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
    });
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
      credentialSource: 'primary',
    });
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 512,
        requestTimeoutMs: 90_000,
        extraBody: {
          chat_template_kwargs: {
            enable_thinking: false,
            force_nonempty_content: true,
          },
        },
        apiKey: 'primary-test-key',
      })
    );
  });

  it('validates the primary key only and never invokes fallback after primary failure', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    const primaryChat = vi.fn().mockRejectedValue(new Error('LLM API error: 401 provider detail'));
    createLLMClient.mockReturnValue({ chat: primaryChat });

    await expect(validateLLMProvider(DEFAULT_CONFIG, process.env, 'primary')).rejects.toMatchObject(
      {
        attempts: [{ source: 'primary', category: 'unauthorized', status: 401 }],
      }
    );
    expect(createLLMClient).toHaveBeenCalledOnce();
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'primary-test-key' })
    );
  });

  it('validates the fallback key only without attempting the primary key', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient.mockReturnValue({
      chat: vi
        .fn()
        .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG, process.env, 'fallback')).resolves.toEqual({
      content: 'TraceMind model connection successful.',
      usedFallback: true,
      credentialSource: 'fallback',
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'fallback-test-key' })
    );
  });

  it('reports a missing selected credential without attempting another key', async () => {
    delete process.env.TRACEMIND_LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.TRACEMIND_LLM_FALLBACK_API_KEY;
    const noConfigKey = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, apiKey: '' },
    };

    await expect(validateLLMProvider(noConfigKey, process.env, 'primary')).rejects.toMatchObject({
      attempts: [{ source: 'primary', category: 'missing_key' }],
      message: 'Provider validation failed. Primary: missing key.',
    });
    expect(createLLMClient).not.toHaveBeenCalled();
  });
});
