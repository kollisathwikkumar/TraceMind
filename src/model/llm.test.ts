import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return { ...actual, complete };
});

import { createLLMClient } from './llm';

describe('OpenAI-compatible model configuration', () => {
  afterEach(() => {
    delete process.env.NVIDIA_API_KEY;
    delete process.env.TRACEMIND_LLM_API_KEY;
  });

  beforeEach(() => {
    complete.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: 'adapter connected' }],
      stopReason: 'stop',
    });
  });

  it('routes a custom model and key to the configured OpenAI-compatible endpoint', async () => {
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'vendor/nemotron-model',
      apiBaseUrl: 'https://api.example.test/v1',
      apiKey: 'test-provider-key',
    });

    await expect(client.chat('system', 'user')).resolves.toMatchObject({
      content: 'adapter connected',
      toolCalls: [],
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai-compatible',
        api: 'openai-completions',
        id: 'vendor/nemotron-model',
        baseUrl: 'https://api.example.test/v1',
      }),
      expect.objectContaining({ systemPrompt: 'system' }),
      expect.objectContaining({ apiKey: 'test-provider-key' })
    );
  });

  it('passes a provider key per request without mutating process-wide credentials', async () => {
    const original = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'existing-process-key';
    try {
      const client = createLLMClient({ provider: 'openai', model: 'gpt-4o', apiKey: 'request-key' });
      await client.chat('system', 'user');
      expect(complete).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ apiKey: 'request-key' })
      );
      expect(process.env.OPENAI_API_KEY).toBe('existing-process-key');
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = original;
    }
  });

  it('requires a base URL for a custom provider', () => {
    expect(() => createLLMClient({ provider: 'openai-compatible', model: 'model-id' })).toThrow(
      'OpenAI-compatible provider requires llm.apiBaseUrl'
    );
  });

  it('forwards NVIDIA_API_KEY when no explicit generic key is set', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-test-key';
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'vendor/model',
      apiBaseUrl: 'https://api.example.test/v1',
    });
    await client.chat('system', 'user');
    expect(complete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ apiKey: 'nvidia-test-key' })
    );
  });

  it('preserves OpenAI-compatible reasoning blocks in pi-ai response shape', async () => {
    complete.mockResolvedValueOnce({
      content: [
        { type: 'thinking', thinking: 'internal reasoning ' },
        { type: 'thinking', thinking: 'continues' },
      ],
      stopReason: 'stop',
    });
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'vendor/reasoning-model',
      apiBaseUrl: 'https://api.example.test/v1',
    });

    await expect(client.chat('system', 'user')).resolves.toMatchObject({
      content: '',
      thinking: 'internal reasoning continues',
      toolCalls: [],
    });
  });

  it('keeps truly empty completions empty for the validation layer to reject', async () => {
    complete.mockResolvedValueOnce({ content: [], stopReason: 'stop' });
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'vendor/empty-model',
      apiBaseUrl: 'https://api.example.test/v1',
    });

    await expect(client.chat('system', 'user')).resolves.toMatchObject({
      content: '',
      thinking: undefined,
      toolCalls: [],
    });
  });

  it('aborts a provider request at the configured timeout', async () => {
    vi.useFakeTimers();
    complete.mockImplementation(
      (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'vendor/model',
      apiBaseUrl: 'https://api.example.test/v1',
      requestTimeoutMs: 25,
    });

    const pending = expect(client.chat('system', 'user')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(25);
    await pending;
    vi.useRealTimers();
  });

  it('adds NVIDIA chat template options to the outbound completion payload', async () => {
    const extraBody = {
      chat_template_kwargs: { enable_thinking: false, force_nonempty_content: true },
    };
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'nvidia/nemotron-3-ultra-550b-a55b',
      apiBaseUrl: 'https://integrate.api.nvidia.com/v1',
      extraBody,
    });

    await client.chat('system', 'user');
    const options = complete.mock.calls[0]?.[2] as { onPayload?: (payload: unknown) => void };
    const payload: Record<string, unknown> = {};
    options.onPayload?.(payload);
    expect(payload).toMatchObject(extraBody);
  });

  it('uses NVIDIA NIM max_tokens parameter compatibility', async () => {
    const client = createLLMClient({
      provider: 'openai-compatible',
      model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      apiBaseUrl: 'https://integrate.api.nvidia.com/v1',
    });

    await client.chat('system', 'user');

    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        compat: expect.objectContaining({ maxTokensField: 'max_tokens' }),
      }),
      expect.any(Object),
      expect.any(Object)
    );
  });
});
