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
  | 'empty_response'
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

class EmptyLLMResponseError extends Error {
  constructor() {
    super('Provider returned an empty response');
    this.name = 'EmptyLLMResponseError';
  }
}

interface CompatibleChatCompletion {
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> | null };
  }>;
}

/** NVIDIA's hosted endpoint is OpenAI-compatible but its streaming responses
 * are occasionally surfaced as usage/reasoning-only chunks by the generic
 * adapter. Use its documented non-streaming Chat Completions contract for the
 * short connection probe, and keep the rest of the application on pi-ai. */
async function validateOpenAICompatible(
  config: Config,
  apiKey: string | undefined,
  timeoutMs: number
): Promise<string> {
  if (!config.llm.apiBaseUrl) throw new Error('OpenAI-compatible provider requires llm.apiBaseUrl');
  if (!apiKey) throw new Error('OpenAI-compatible provider API key is not configured');

  const baseUrl = config.llm.apiBaseUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: VALIDATION_SYSTEM_PROMPT },
        { role: 'user', content: VALIDATION_USER_PROMPT },
      ],
      max_tokens: 128,
      temperature: 0,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  if (!response.ok) {
    const error = new Error(`OpenAI-compatible provider returned HTTP ${response.status}`);
    Object.assign(error, { status: response.status });
    throw error;
  }

  let payload: CompatibleChatCompletion;
  try {
    payload = (await response.json()) as CompatibleChatCompletion;
  } catch {
    throw new Error('OpenAI-compatible provider returned invalid JSON');
  }
  const content = payload.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join('')
        : '';
  if (!text.trim()) throw new EmptyLLMResponseError();
  return text.trim();
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
  if (error instanceof EmptyLLMResponseError) return { source, category: 'empty_response' };
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
  };

  // Runtime environment is the deployment source of truth. Prefer it over a
  // possibly stale key persisted in config.yaml so key rotation takes effect
  // without requiring a config-file edit or rebuild.
  const primaryKey =
    environment.TRACEMIND_LLM_API_KEY?.trim() ||
    environment.NVIDIA_API_KEY?.trim() ||
    config.llm.apiKey;
  const fallbackKey = environment.TRACEMIND_LLM_FALLBACK_API_KEY?.trim();
  const runAttempt = async (apiKey: string | undefined): Promise<string> => {
    if (config.llm.provider === 'openai-compatible') {
      return validateOpenAICompatible(config, apiKey, base.requestTimeoutMs);
    }
    const result = await createLLMClient({ ...base, apiKey }).chat(
      VALIDATION_SYSTEM_PROMPT,
      VALIDATION_USER_PROMPT
    );
    const content = result.content.trim();
    if (!content) throw new EmptyLLMResponseError();
    return content;
  };

  try {
    const content = await runAttempt(primaryKey);
    return { content, usedFallback: false };
  } catch (primaryError) {
    const attempts = [classifyLLMProviderFailure(primaryError, 'primary')];
    if (!fallbackKey || fallbackKey === primaryKey) throw new LLMValidationError(attempts);
    try {
      const content = await runAttempt(fallbackKey);
      return { content, usedFallback: true };
    } catch (fallbackError) {
      attempts.push(classifyLLMProviderFailure(fallbackError, 'fallback'));
      throw new LLMValidationError(attempts);
    }
  }
}
