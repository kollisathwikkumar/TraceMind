import { createLLMClient } from '../model/llm';
import type { Config } from '../utils/config';

const VALIDATION_SYSTEM_PROMPT =
  'You are validating a model connection. Follow the user instruction exactly.';
const VALIDATION_USER_PROMPT = 'Reply with exactly: TraceMind model connection successful.';

export interface LLMValidationResponse {
  content: string;
  usedFallback: boolean;
}

export type LLMProviderFailureCategory =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'upstream_http'
  | 'unknown';

export interface LLMProviderAttemptFailure {
  source: 'primary' | 'fallback';
  category: LLMProviderFailureCategory;
  status?: number;
}

/** Contains only allowlisted diagnostic metadata; never retains provider error text. */
export class LLMValidationError extends Error {
  constructor(readonly attempts: LLMProviderAttemptFailure[]) {
    super(formatLLMValidationFailure(attempts));
    this.name = 'LLMValidationError';
  }
}

function statusFromError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status]) {
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
  }

  // pi-ai normalizes provider failures into an Error message before the
  // application receives them. Extract only a leading HTTP status, never its
  // body/message, which may include provider request details.
  if (typeof candidate.message === 'string') {
    const match = candidate.message.match(/(?:^|:\s)([1-5]\d{2})(?:\s|$)/);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === 'string') return error;
  return '';
}

export function classifyLLMProviderFailure(
  error: unknown,
  source: LLMProviderAttemptFailure['source']
): LLMProviderAttemptFailure {
  const status = statusFromError(error);
  const text = errorText(error);
  let category: LLMProviderFailureCategory;
  if (status === 401) category = 'unauthorized';
  else if (status === 403) category = 'forbidden';
  else if (status === 404) category = 'not_found';
  else if (status === 429) category = 'rate_limited';
  else if (status !== undefined) category = 'upstream_http';
  else if (/timeout|timed out|request was aborted|aborterror/i.test(text)) category = 'timeout';
  else if (
    /fetch failed|network|econn|enotfound|eai_again|socket|connection (?:error|refused|reset)|tls|und_err/i.test(
      text
    )
  ) {
    category = 'network';
  } else category = 'unknown';

  return { source, category, ...(status === undefined ? {} : { status }) };
}

export function formatLLMValidationFailure(attempts: LLMProviderAttemptFailure[]): string {
  const details = attempts
    .map(({ source, category, status }) => {
      const label = source === 'primary' ? 'Primary' : 'Fallback';
      return `${label}: ${category.replaceAll('_', ' ')}${status ? ` (HTTP ${status})` : ''}`;
    })
    .join('; ');
  return `Provider validation failed${details ? `. ${details}.` : '.'}`;
}

/** Run the fixed validation prompt with the configured key, then the optional fallback key. */
export async function validateLLMProvider(
  config: Config,
  environment: NodeJS.ProcessEnv = process.env
): Promise<LLMValidationResponse> {
  const base = {
    ...config.llm,
    requestTimeoutMs: 45_000,
    extraBody: {
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    },
  };

  // Runtime environment is the deployment source of truth. Prefer it over a
  // possibly stale key persisted in config.yaml so key rotation takes effect
  // without requiring a config-file edit or rebuild.
  const primaryKey =
    environment.TRACEMIND_LLM_API_KEY?.trim() ||
    environment.NVIDIA_API_KEY?.trim() ||
    config.llm.apiKey;
  const fallbackKey = environment.TRACEMIND_LLM_FALLBACK_API_KEY?.trim();

  try {
    const result = await createLLMClient({ ...base, apiKey: primaryKey }).chat(
      VALIDATION_SYSTEM_PROMPT,
      VALIDATION_USER_PROMPT
    );
    return { content: result.content, usedFallback: false };
  } catch (primaryError) {
    const attempts = [classifyLLMProviderFailure(primaryError, 'primary')];
    if (!fallbackKey || fallbackKey === primaryKey) throw new LLMValidationError(attempts);
    try {
      const result = await createLLMClient({ ...base, apiKey: fallbackKey }).chat(
        VALIDATION_SYSTEM_PROMPT,
        VALIDATION_USER_PROMPT
      );
      return { content: result.content, usedFallback: true };
    } catch (fallbackError) {
      attempts.push(classifyLLMProviderFailure(fallbackError, 'fallback'));
      throw new LLMValidationError(attempts);
    }
  }
}
