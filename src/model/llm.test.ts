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
});
