import { describe, expect, it } from 'vitest';
import { formatValidationStatus } from './Dashboard';
import type { LLMValidationResult } from '../api';

describe('dashboard model validation status', () => {
  it('shows the sanitized primary failure when fallback succeeds', () => {
    const result: LLMValidationResult = {
      status: 'connected',
      provider: 'openai-compatible',
      model: 'test-model',
      response: 'connected',
      checkedAt: '2026-10-17T00:00:00.000Z',
      usedFallback: true,
      primaryFailure: { category: 'unauthorized', status: 401 },
    };

    expect(formatValidationStatus(result)).toBe(
      'fallback provider used (primary: unauthorized, HTTP 401)'
    );
  });

  it('identifies successful primary validation', () => {
    const result: LLMValidationResult = {
      status: 'connected',
      provider: 'openai-compatible',
      model: 'test-model',
      response: 'connected',
      checkedAt: '2026-10-17T00:00:00.000Z',
      usedFallback: false,
    };

    expect(formatValidationStatus(result)).toBe('primary provider used');
  });

  it('identifies fallback-key-only validation without implying primary fallback occurred', () => {
    const result: LLMValidationResult = {
      status: 'connected',
      provider: 'openai-compatible',
      model: 'test-model',
      response: 'connected',
      checkedAt: '2026-10-17T00:00:00.000Z',
      usedFallback: true,
      credentialSource: 'fallback',
    };

    expect(formatValidationStatus(result)).toBe('fallback key validated independently');
  });
});
