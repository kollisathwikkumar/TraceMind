import { createLLMClient } from '../model/llm';
import type { Config } from '../utils/config';

const VALIDATION_SYSTEM_PROMPT =
  'You are validating a model connection. Follow the user instruction exactly.';
const VALIDATION_USER_PROMPT = 'Reply with exactly: TraceMind model connection successful.';

export interface LLMValidationResponse {
  content: string;
  usedFallback: boolean;
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
    if (!fallbackKey || fallbackKey === primaryKey) throw primaryError;
    const result = await createLLMClient({ ...base, apiKey: fallbackKey }).chat(
      VALIDATION_SYSTEM_PROMPT,
      VALIDATION_USER_PROMPT
    );
    return { content: result.content, usedFallback: true };
  }
}
