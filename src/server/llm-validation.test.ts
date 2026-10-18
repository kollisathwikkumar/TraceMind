import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createLLMClient } = vi.hoisted(() => ({ createLLMClient: vi.fn() }));
vi.mock('../model/llm', () => ({ createLLMClient }));

import { DEFAULT_CONFIG } from '../utils/config';
import {
  classifyLLMProviderFailure,
  LLMValidationError,
  resolvePrimaryProviderApiKey,
  validateLLMProvider,
} from './llm-validation';

describe('LLM validation fallback', () => {
  afterEach(() => {
    delete process.env.TRACEMIND_LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.TRACEMIND_LLM_FALLBACK_API_KEY;
    delete process.env.TRACEMIND_LLM_FALLBACK_PROVIDER;
    delete process.env.TRACEMIND_LLM_FALLBACK_MODEL;
    delete process.env.TRACEMIND_LLM_FALLBACK_API_BASE_URL;
    delete process.env.TRACEMIND_LLM_FALLBACK_BASE_URL;
  });

  beforeEach(() => {
    createLLMClient.mockReset();
    vi.unstubAllGlobals();
  });

  it('uses GEMINI_API_KEY for the Google Generative AI adapter', async () => {
    const googleConfig = {
      ...DEFAULT_CONFIG,
      llm: { ...DEFAULT_CONFIG.llm, provider: 'google' as const, model: 'gemini-2.5-flash' },
    };
    const environment = { GEMINI_API_KEY: 'gemini-test-key' } as NodeJS.ProcessEnv;
    createLLMClient.mockReturnValue({
      chat: vi
        .fn()
        .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
    });

    expect(resolvePrimaryProviderApiKey(googleConfig, environment)).toBe('gemini-test-key');
    await expect(validateLLMProvider(googleConfig, environment, 'primary')).resolves.toMatchObject({
      provider: 'google',
      model: 'gemini-2.5-flash',
      credentialSource: 'primary',
    });
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'gemini-test-key', provider: 'google' })
    );
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
      provider: DEFAULT_CONFIG.llm.provider,
      model: DEFAULT_CONFIG.llm.model,
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
      provider: DEFAULT_CONFIG.llm.provider,
      model: DEFAULT_CONFIG.llm.model,
      primaryFailure: { source: 'primary', category: 'empty_response' },
    });
    expect(createLLMClient).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a reasoning-only stream from a genuinely empty provider result', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    createLLMClient
      .mockReturnValueOnce({
        chat: vi.fn().mockResolvedValue({
          content: '',
          thinking: 'internal reasoning is deliberately not returned',
          toolCalls: [],
        }),
      })
      .mockReturnValueOnce({
        chat: vi.fn().mockResolvedValue({
          content: 'TraceMind model connection successful.',
          toolCalls: [],
        }),
      });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).resolves.toMatchObject({
      usedFallback: true,
      primaryFailure: { source: 'primary', category: 'reasoning_only' },
    });
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

  it.each([
    ['authentication failed: private details', 'unauthorized'],
    ['permission denied: private details', 'forbidden'],
    ['model vendor/unknown-model not found', 'not_found'],
    ['rate limit exceeded: private details', 'rate_limited'],
  ] as const)('normalizes provider diagnostic %s to %s', (message, category) => {
    expect(classifyLLMProviderFailure(new Error(message), 'fallback')).toEqual({
      source: 'fallback',
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
      provider: DEFAULT_CONFIG.llm.provider,
      model: DEFAULT_CONFIG.llm.model,
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

  it('requires an explicit fallback model when the fallback provider differs', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_PROVIDER = 'anthropic';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockRejectedValue(new Error('primary failed')),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).rejects.toMatchObject({
      attempts: [
        { source: 'primary', category: 'unknown' },
        { source: 'fallback', category: 'missing_configuration' },
      ],
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
  });

  it('requires a fallback URL when a changed fallback provider is OpenAI-compatible', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'fallback-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_PROVIDER = 'openai-compatible';
    process.env.TRACEMIND_LLM_FALLBACK_MODEL = 'fallback/model';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockRejectedValue(new Error('primary failed')),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).rejects.toMatchObject({
      attempts: [
        { source: 'primary', category: 'unknown' },
        { source: 'fallback', category: 'missing_configuration' },
      ],
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
  });

  it('uses NVIDIA direct-answer request options for NVIDIA NIM validation', async () => {
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
      provider: compatibleConfig.llm.provider,
      model: compatibleConfig.llm.model,
    });
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 512,
        requestTimeoutMs: 90_000,
        extraBody: {
          chat_template_kwargs: { enable_thinking: false },
        },
        apiKey: 'primary-test-key',
      })
    );
  });

  it('does not send NVIDIA-specific template fields to other OpenAI-compatible hosts', async () => {
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
        model: 'vendor/model',
        apiBaseUrl: 'https://api.example.test/v1/',
      },
    };

    await validateLLMProvider(compatibleConfig, { TRACEMIND_LLM_API_KEY: 'primary-test-key' });

    expect(createLLMClient).toHaveBeenCalledWith(
      expect.not.objectContaining({ extraBody: expect.anything() })
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
      provider: DEFAULT_CONFIG.llm.provider,
      model: DEFAULT_CONFIG.llm.model,
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'fallback-test-key' })
    );
  });

  it('uses the dedicated fallback provider, model, base URL, and fallback credential together', async () => {
    const environment = {
      TRACEMIND_LLM_API_KEY: 'primary-test-key',
      TRACEMIND_LLM_FALLBACK_API_KEY: 'fallback-test-key',
      TRACEMIND_LLM_FALLBACK_PROVIDER: 'openai-compatible',
      TRACEMIND_LLM_FALLBACK_MODEL: 'vendor/fallback-model',
      TRACEMIND_LLM_FALLBACK_API_BASE_URL: 'https://fallback.example.test/v1/',
    };
    createLLMClient.mockReturnValue({
      chat: vi
        .fn()
        .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
    });

    await expect(
      validateLLMProvider(DEFAULT_CONFIG, environment, 'fallback')
    ).resolves.toMatchObject({
      credentialSource: 'fallback',
      usedFallback: true,
      provider: 'openai-compatible',
      model: 'vendor/fallback-model',
    });
    expect(createLLMClient).toHaveBeenCalledOnce();
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'vendor/fallback-model',
        apiBaseUrl: 'https://fallback.example.test/v1/',
        apiKey: 'fallback-test-key',
      })
    );
  });

  it('supports the legacy fallback base URL and leaves primary provider selection unchanged', async () => {
    const environment = {
      TRACEMIND_LLM_API_KEY: 'primary-test-key',
      TRACEMIND_LLM_FALLBACK_API_KEY: 'fallback-test-key',
      TRACEMIND_LLM_FALLBACK_PROVIDER: 'openai-compatible',
      TRACEMIND_LLM_FALLBACK_MODEL: 'vendor/fallback-model',
      TRACEMIND_LLM_FALLBACK_BASE_URL: 'https://legacy-fallback.example.test/v1/',
    };
    createLLMClient
      .mockReturnValueOnce({ chat: vi.fn().mockRejectedValue(new Error('primary unavailable')) })
      .mockReturnValueOnce({
        chat: vi
          .fn()
          .mockResolvedValue({ content: 'TraceMind model connection successful.', toolCalls: [] }),
      });

    await validateLLMProvider(DEFAULT_CONFIG, environment);
    expect(createLLMClient).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: DEFAULT_CONFIG.llm.provider,
        model: DEFAULT_CONFIG.llm.model,
        apiBaseUrl: DEFAULT_CONFIG.llm.apiBaseUrl,
        apiKey: 'primary-test-key',
      })
    );
    expect(createLLMClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: 'openai-compatible',
        model: 'vendor/fallback-model',
        apiBaseUrl: 'https://legacy-fallback.example.test/v1/',
        apiKey: 'fallback-test-key',
      })
    );
  });

  it('does not try the primary credential when explicitly validating a missing fallback key', async () => {
    await expect(
      validateLLMProvider(DEFAULT_CONFIG, { TRACEMIND_LLM_API_KEY: 'primary-test-key' }, 'fallback')
    ).rejects.toMatchObject({
      attempts: [{ source: 'fallback', category: 'missing_key' }],
    });
    expect(createLLMClient).not.toHaveBeenCalled();
  });

  it('reports a missing selected credential without attempting another key', async () => {
    delete process.env.TRACEMIND_LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
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
