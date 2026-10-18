import { createLLMClient } from '../model/llm';
import type { Config } from '../utils/config';

const VALIDATION_SYSTEM_PROMPT =
  'You are validating a model connection. Follow the user instruction exactly.';
const VALIDATION_USER_PROMPT = 'Reply with exactly: TraceMind model connection successful.';
const VALIDATION_EXPECTED_RESPONSE = 'TraceMind model connection successful.';

export interface LLMValidationResponse {
  content: string;
  usedFallback: boolean;
  credentialSource: 'primary' | 'fallback';
  provider?: string;
  model?: string;
  /** Sanitized primary-key failure, present only when fallback answered. */
  primaryFailure?: LLMProviderAttemptFailure;
}

export type LLMProviderFailureCategory =
  | 'missing_key'
  | 'missing_configuration'
  | 'reasoning_only'
  | 'unexpected_response'
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
  constructor(readonly hadReasoning: boolean) {
    super('Provider returned an empty response');
    this.name = 'EmptyLLMResponseError';
  }
}

class UnexpectedLLMResponseError extends Error {
  constructor() {
    super('Provider returned text that did not match the validation sentinel');
    this.name = 'UnexpectedLLMResponseError';
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

/** Resolve the documented provider credential without exposing it in diagnostics. */
export function resolvePrimaryProviderApiKey(
  config: Pick<Config, 'llm'>,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  // This generic deployment override has always been supported for the
  // configured primary provider, so keep its precedence for rotations.
  const deploymentKey =
    environment.TRACEMIND_LLM_API_KEY?.trim() || environment.NVIDIA_API_KEY?.trim();
  if (deploymentKey) return deploymentKey;
  if (config.llm.provider === 'google') {
    // pi-ai's Google adapter uses GEMINI_API_KEY. Keep the historic alias so
    // existing self-hosted deployments can migrate without a surprise outage.
    return (
      environment.GEMINI_API_KEY?.trim() || environment.GOOGLE_API_KEY?.trim() || config.llm.apiKey
    );
  }
  return config.llm.apiKey;
}

export function classifyLLMProviderFailure(
  error: unknown,
  source: LLMProviderAttemptFailure['source']
): LLMProviderAttemptFailure {
  if (error instanceof EmptyLLMResponseError) {
    return { source, category: error.hadReasoning ? 'reasoning_only' : 'empty_response' };
  }
  if (error instanceof UnexpectedLLMResponseError)
    return { source, category: 'unexpected_response' };
  const status = statusFromError(error);
  const text = errorText(error);
  let category: LLMProviderFailureCategory;
  if (status === 401) category = 'unauthorized';
  else if (status === 403) category = 'forbidden';
  else if (status === 404) category = 'not_found';
  else if (status === 429) category = 'rate_limited';
  else if (status !== undefined) category = 'upstream_http';
  else if (/unauthori[sz]ed|invalid (?:api )?key|authentication failed/i.test(text))
    category = 'unauthorized';
  else if (/forbidden|permission denied|insufficient scope/i.test(text)) category = 'forbidden';
  else if (/model .*not found|unknown model|endpoint .*not found/i.test(text))
    category = 'not_found';
  else if (/rate.?limit|too many requests|quota exceeded/i.test(text)) category = 'rate_limited';
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
  environment: NodeJS.ProcessEnv = process.env,
  credentialSource: 'auto' | 'primary' | 'fallback' = 'auto'
): Promise<LLMValidationResponse> {
  const fallbackProvider = environment.TRACEMIND_LLM_FALLBACK_PROVIDER?.trim();
  const fallbackModel = environment.TRACEMIND_LLM_FALLBACK_MODEL?.trim();
  const fallbackBaseUrl =
    environment.TRACEMIND_LLM_FALLBACK_API_BASE_URL?.trim() ||
    environment.TRACEMIND_LLM_FALLBACK_BASE_URL?.trim();

  // Keep each credential attached to its own provider configuration. In
  // particular, a fallback NVIDIA key must not be probed against the primary
  // model/host when the fallback provider has been configured separately.
  const attemptConfig = (source: 'primary' | 'fallback') => {
    const isFallback = source === 'fallback';
    const provider = (
      isFallback && fallbackProvider ? fallbackProvider : config.llm.provider
    ) as Config['llm']['provider'];
    const providerChanged = isFallback && provider !== config.llm.provider;
    const model =
      isFallback && fallbackModel ? fallbackModel : providerChanged ? '' : config.llm.model;
    const apiBaseUrl =
      isFallback && fallbackBaseUrl
        ? fallbackBaseUrl
        : providerChanged
          ? undefined
          : config.llm.apiBaseUrl;
    const usesNvidiaNim =
      provider === 'openai-compatible' && apiBaseUrl?.includes('integrate.api.nvidia.com');

    return {
      ...config.llm,
      provider,
      model,
      apiBaseUrl,
      // Validation asks for a fixed, tiny answer, so disable long-form
      // reasoning and reserve only a small visible-output budget. NVIDIA's
      // hosted NIM guide uses this direct-answer mode for simple prompts.
      maxTokens: provider === 'openai-compatible' ? 512 : 256,
      requestTimeoutMs: provider === 'openai-compatible' ? 90_000 : 45_000,
      ...(usesNvidiaNim ? { extraBody: { chat_template_kwargs: { enable_thinking: false } } } : {}),
    };
  };

  // Runtime environment is the deployment source of truth. Prefer it over a
  // possibly stale key persisted in config.yaml so key rotation takes effect
  // without requiring a config-file edit or rebuild.
  const primaryKey = resolvePrimaryProviderApiKey(config, environment);
  const fallbackKey = environment.TRACEMIND_LLM_FALLBACK_API_KEY?.trim();
  const runAttempt = async (
    source: 'primary' | 'fallback',
    apiKey: string | undefined
  ): Promise<{ content: string; provider: string; model: string }> => {
    const selectedConfig = attemptConfig(source);
    if (
      !selectedConfig.model ||
      (selectedConfig.provider === 'openai-compatible' && !selectedConfig.apiBaseUrl)
    ) {
      throw new LLMValidationError([{ source, category: 'missing_configuration' }]);
    }
    const result = await createLLMClient({ ...selectedConfig, apiKey }).chat(
      VALIDATION_SYSTEM_PROMPT,
      VALIDATION_USER_PROMPT
    );
    const content = result.content.trim();
    if (!content) throw new EmptyLLMResponseError(Boolean(result.thinking?.trim()));
    // The probe deliberately asks for a fixed sentinel. A reasoning-only
    // stream or unrelated provider text must not be reported as connected.
    if (content !== VALIDATION_EXPECTED_RESPONSE) {
      throw new UnexpectedLLMResponseError();
    }
    return { content, provider: selectedConfig.provider, model: selectedConfig.model };
  };

  // Explicit key checks are single-attempt by design: validating one secret
  // must never silently succeed by switching to the other credential.
  if (credentialSource !== 'auto') {
    const selectedKey = credentialSource === 'primary' ? primaryKey : fallbackKey;
    if (!selectedKey) {
      throw new LLMValidationError([{ source: credentialSource, category: 'missing_key' }]);
    }
    try {
      return {
        ...(await runAttempt(credentialSource, selectedKey)),
        usedFallback: credentialSource === 'fallback',
        credentialSource,
      };
    } catch (error) {
      if (error instanceof LLMValidationError) throw error;
      throw new LLMValidationError([classifyLLMProviderFailure(error, credentialSource)]);
    }
  }

  try {
    const result = await runAttempt('primary', primaryKey);
    return { ...result, usedFallback: false, credentialSource: 'primary' };
  } catch (primaryError) {
    const attempts = [classifyLLMProviderFailure(primaryError, 'primary')];
    if (!fallbackKey || fallbackKey === primaryKey) throw new LLMValidationError(attempts);
    try {
      const result = await runAttempt('fallback', fallbackKey);
      // Keep the successful fallback result while exposing only the
      // allowlisted primary failure category/status for key diagnosis.
      return {
        ...result,
        usedFallback: true,
        credentialSource: 'fallback',
        primaryFailure: attempts[0],
      };
    } catch (fallbackError) {
      if (fallbackError instanceof LLMValidationError) {
        attempts.push(...fallbackError.attempts);
        throw new LLMValidationError(attempts);
      }
      attempts.push(classifyLLMProviderFailure(fallbackError, 'fallback'));
      throw new LLMValidationError(attempts);
    }
  }
}
