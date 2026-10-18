/**
 * LLM Client
 *
 * Provides a unified interface for calling language models with tool support.
 * Uses @mariozechner/pi-ai for multi-provider support (20+ providers).
 */

import {
  getModel,
  complete,
  type Context,
  type Tool as PiTool,
  Type,
  type TSchema,
} from '@mariozechner/pi-ai';
import type { Tool } from '../agent/types';
import type { LLMClient, LLMResponse, ToolCall, StreamChunk } from '../agent/agent';

// Re-export types for external use
export type { LLMClient, LLMResponse, ToolCall, StreamChunk };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyModel = any;

// Supported providers from pi-ai
export type Provider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'mistral'
  | 'groq'
  | 'xai'
  | 'openrouter'
  | 'bedrock'
  | 'azure'
  | 'vertex'
  | 'cerebras'
  | 'github'
  | 'ollama'
  | 'openai-compatible';

export interface LLMConfig {
  provider: Provider;
  model: string;
  apiKey?: string;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  extraBody?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_CONFIG: LLMConfig = {
  provider: 'openai',
  model: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0,
};

/**
 * Create an LLM client based on configuration
 */
export function createLLMClient(config: Partial<LLMConfig> = {}): LLMClient {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  return new PiAIClient(fullConfig);
}

/**
 * Unified LLM client using pi-ai
 */
class PiAIClient implements LLMClient {
  private model: AnyModel;
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;

    if (config.provider === 'openai-compatible') {
      if (!config.apiBaseUrl) {
        throw new Error('OpenAI-compatible provider requires llm.apiBaseUrl');
      }
      const isNvidiaHosted = config.apiBaseUrl.includes('integrate.api.nvidia.com');
      this.model = {
        id: config.model,
        name: config.model,
        api: 'openai-completions',
        provider: 'openai-compatible',
        baseUrl: config.apiBaseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: config.maxTokens || 4096,
        compat: {
          supportsStore: false,
          supportsUsageInStreaming: false,
          // NVIDIA NIM documents `max_tokens`; pi-ai otherwise sends
          // `max_completion_tokens` for unknown OpenAI-compatible hosts.
          ...(isNvidiaHosted ? { maxTokensField: 'max_tokens' as const } : {}),
        },
      };
    } else {
      // Get model from pi-ai's provider registry.
      this.model = getModel(config.provider as 'openai', config.model as 'gpt-4o');
    }

    // Validate that the model was found
    if (!this.model) {
      throw new Error(
        `Model "${config.model}" is not supported for provider "${config.provider}". ` +
          `Try using a different model name (e.g., gpt-4o for OpenAI, claude-sonnet-4-20250514 for Anthropic).`
      );
    }
  }

  async chat(systemPrompt: string, userPrompt: string, tools?: Tool[]): Promise<LLMResponse> {
    // Convert tools to pi-ai format
    const piTools = tools?.map((t) => this.convertTool(t));

    // Build context
    const context: Context = {
      systemPrompt,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: userPrompt }],
          timestamp: Date.now(),
        },
      ],
      tools: piTools,
    };

    const controller = this.config.requestTimeoutMs ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(), this.config.requestTimeoutMs)
      : undefined;
    try {
      // Make completion request
      const response = await complete(this.model, context, {
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        signal: controller?.signal,
        onPayload: this.config.extraBody
          ? (payload) => {
              if (payload && typeof payload === 'object') {
                Object.assign(payload, this.config.extraBody);
              }
            }
          : undefined,
        apiKey:
          this.config.apiKey ||
          (this.config.provider === 'openai-compatible'
            ? process.env.TRACEMIND_LLM_API_KEY || process.env.NVIDIA_API_KEY
            : undefined),
      });

      // Parse response
      return this.parseResponse(response);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const wrapped = new Error(
        `LLM API error (${this.config.provider}/${this.config.model}): ${errorMessage}`
      );
      if (error && typeof error === 'object') {
        const candidate = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
        const status = [candidate.status, candidate.statusCode, candidate.response?.status].find(
          (value): value is number => typeof value === 'number' && value >= 100 && value <= 599
        );
        if (status !== undefined) Object.assign(wrapped, { status });
      }
      throw wrapped;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Streaming chat completion
   *
   * Yields chunks of the response as they arrive.
   * Falls back to chunking the non-streaming response if streaming is not supported.
   */
  async *chatStream(
    systemPrompt: string,
    userPrompt: string,
    tools?: Tool[]
  ): AsyncGenerator<StreamChunk> {
    // pi-ai may not support streaming for all providers
    // Fall back to chunking the complete response
    try {
      const response = await this.chat(systemPrompt, userPrompt, tools);

      // Yield thinking first if present
      if (response.thinking) {
        yield {
          type: 'thinking',
          content: response.thinking,
        };
      }

      // Yield tool calls
      for (const toolCall of response.toolCalls) {
        yield {
          type: 'tool_call',
          toolCall,
        };
      }

      // Simulate streaming by chunking the content
      if (response.content) {
        const chunkSize = 50; // characters per chunk
        const content = response.content;
        for (let i = 0; i < content.length; i += chunkSize) {
          yield {
            type: 'text',
            content: content.slice(i, i + chunkSize),
          };
          // Small delay to simulate streaming
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      // Final done event with complete response
      yield {
        type: 'done',
        response,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `LLM streaming error (${this.config.provider}/${this.config.model}): ${errorMessage}`
      );
    }
  }

  /**
   * Convert our tool format to pi-ai's format
   */
  private convertTool(tool: Tool): PiTool {
    // Build TypeBox schema from our parameters
    const properties: Record<string, TSchema> = {};

    for (const [key, value] of Object.entries(tool.parameters.properties)) {
      if (value.type === 'string') {
        properties[key] = Type.String({ description: value.description });
      } else if (value.type === 'number') {
        properties[key] = Type.Number({ description: value.description });
      } else if (value.type === 'boolean') {
        properties[key] = Type.Boolean({ description: value.description });
      } else if (value.type === 'array') {
        properties[key] = Type.Array(Type.String(), { description: value.description });
      } else if (value.type === 'object') {
        properties[key] = Type.Record(Type.String(), Type.Unknown(), {
          description: value.description,
        });
      } else {
        properties[key] = Type.Unknown({ description: value.description });
      }
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: Type.Object(properties),
    };
  }

  /**
   * Parse pi-ai response into our format
   */
  private parseResponse(response: {
    content?: Array<{
      type: string;
      text?: string;
      /** pi-ai stores OpenAI-compatible reasoning here, not in `text`. */
      thinking?: string;
      id?: string;
      name?: string;
      arguments?: unknown;
    }>;
    stopReason?: string;
    errorMessage?: string;
  }): LLMResponse {
    if (response.stopReason === 'error') {
      throw new Error(response.errorMessage || 'Provider returned an unknown error');
    }

    let content = '';
    const toolCalls: ToolCall[] = [];
    let thinking: string | undefined;

    for (const block of response.content ?? []) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'toolCall' && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          args: (block.arguments as Record<string, unknown>) || {},
        });
      } else if (block.type === 'thinking') {
        // pi-ai's OpenAI-compatible streaming adapter maps reasoning_content,
        // reasoning, and reasoning_text to `{ type: 'thinking', thinking }`.
        // Keep legacy adapters' `text` representation compatible as well.
        const reasoning = block.thinking ?? block.text;
        if (reasoning) thinking = thinking ? `${thinking}${reasoning}` : reasoning;
      }
    }

    return { content, toolCalls, thinking };
  }
}

/**
 * Mock LLM client for testing
 */
export class MockLLMClient implements LLMClient {
  private responses: LLMResponse[] = [];
  private callIndex = 0;

  addResponse(response: LLMResponse): void {
    this.responses.push(response);
  }

  async chat(_systemPrompt: string, _userPrompt: string, _tools?: Tool[]): Promise<LLMResponse> {
    if (this.callIndex >= this.responses.length) {
      return { content: 'No more mock responses', toolCalls: [] };
    }
    return this.responses[this.callIndex++];
  }

  reset(): void {
    this.callIndex = 0;
  }
}
