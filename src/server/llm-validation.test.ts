import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createLLMClient } = vi.hoisted(() => ({ createLLMClient: vi.fn() }));
vi.mock('../model/llm', () => ({ createLLMClient }));

import { DEFAULT_CONFIG } from '../utils/config';
import { validateLLMProvider } from './llm-validation';

describe('LLM validation fallback', () => {
  afterEach(() => {
    delete process.env.TRACEMIND_LLM_API_KEY;
    delete process.env.NVIDIA_API_KEY;
    delete process.env.TRACEMIND_LLM_FALLBACK_API_KEY;
  });

  beforeEach(() => {
    createLLMClient.mockReset();
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

  it('does not retry with a missing or duplicate fallback key', async () => {
    process.env.TRACEMIND_LLM_API_KEY = 'primary-test-key';
    process.env.TRACEMIND_LLM_FALLBACK_API_KEY = 'primary-test-key';
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    });

    await expect(validateLLMProvider(DEFAULT_CONFIG)).rejects.toThrow('provider unavailable');
    expect(createLLMClient).toHaveBeenCalledOnce();
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
});
