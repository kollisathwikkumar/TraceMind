import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_CONFIG, loadConfig, validateConfig, type Config } from '../config';

function cloneConfig(): Config {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  config.llm.apiKey = 'test-key';
  return config;
}

afterEach(() => {
  delete process.env.RUNBOOK_NOTION_API_KEY;
  delete process.env.NOTION_API_KEY;
  delete process.env.RUNBOOK_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.TRACEMIND_DATABASE_URL;
  delete process.env.NVIDIA_API_KEY;
  delete process.env.TRACEMIND_LLM_API_KEY;
  delete process.env.TRACEMIND_LLM_PROVIDER;
  delete process.env.TRACEMIND_LLM_MODEL;
  delete process.env.TRACEMIND_LLM_API_BASE_URL;
});

describe('validateConfig knowledge source checks', () => {
  it('keeps FalkorDB optional and provides a stable graph name by default', () => {
    expect(DEFAULT_CONFIG.graph).toEqual({ graphName: 'runbook', orgId: 'default' });
    expect(DEFAULT_CONFIG.server.host).toBe('127.0.0.1');
    expect(DEFAULT_CONFIG.server.cors).toEqual({ enabled: false, origins: [] });
  });

  it('accepts valid notion/github/api source credentials', () => {
    const config = cloneConfig();
    config.knowledge.sources = [
      {
        type: 'notion',
        databaseId: 'db_123',
        apiKey: 'secret_notion',
      },
      {
        type: 'github',
        repo: 'acme/runbooks',
        token: 'ghp_token',
        branch: 'main',
        path: 'docs/runbooks',
      },
      {
        type: 'api',
        endpoint: 'https://knowledge.internal/documents',
        auth: {
          type: 'bearer',
          value: 'api_token',
        },
      },
    ];

    const errors = validateConfig(config);
    expect(errors.filter((error) => error.startsWith('Knowledge source'))).toEqual([]);
  });

  it('supports environment variable fallback for notion/github tokens', () => {
    process.env.RUNBOOK_NOTION_API_KEY = 'notion_env_token';
    process.env.GITHUB_TOKEN = 'github_env_token';

    const config = cloneConfig();
    config.knowledge.sources = [
      {
        type: 'notion',
        databaseId: 'db_abc',
      },
      {
        type: 'github',
        repo: 'acme/platform',
      },
    ];

    const errors = validateConfig(config);
    expect(errors.filter((error) => error.startsWith('Knowledge source'))).toEqual([]);
  });

  it('returns clear errors for incomplete knowledge sources', () => {
    const config = cloneConfig();
    config.knowledge.sources = [
      { type: 'filesystem' },
      { type: 'confluence', baseUrl: 'https://example.atlassian.net' },
      {
        type: 'google_drive',
        folderIds: ['folder_1'],
        clientId: 'client_id',
        clientSecret: 'client_secret',
      },
      { type: 'notion' },
      { type: 'github' },
      { type: 'api' },
    ];

    const errors = validateConfig(config);

    expect(errors.some((error) => error.includes('filesystem'))).toBe(true);
    expect(errors.some((error) => error.includes('confluence'))).toBe(true);
    expect(errors.some((error) => error.includes('google_drive'))).toBe(true);
    expect(errors.some((error) => error.includes('notion'))).toBe(true);
    expect(errors.some((error) => error.includes('github'))).toBe(true);
    expect(errors.some((error) => error.includes('api'))).toBe(true);
  });
});

describe('TraceMind configuration', () => {
  it('accepts an OpenAI-compatible LLM endpoint with an explicit key', () => {
    const config = cloneConfig();
    config.llm = {
      ...config.llm,
      provider: 'openai-compatible',
      model: 'vendor/nemotron-model',
      apiBaseUrl: 'https://api.example.test/v1',
      apiKey: 'provider-test-key',
    };
    expect(validateConfig(config).filter((error) => error.startsWith('AI model'))).toEqual([]);
  });

  it('recognizes NVIDIA_API_KEY for OpenAI-compatible providers', () => {
    process.env.NVIDIA_API_KEY = 'nvidia-test-key';
    const config = cloneConfig();
    config.llm = {
      ...config.llm,
      provider: 'openai-compatible',
      model: 'vendor/model',
      apiBaseUrl: 'https://api.example.test/v1',
      apiKey: undefined,
    };
    expect(validateConfig(config).filter((error) => error.startsWith('AI model'))).toEqual([]);
  });

  it('resolves environment-backed database URLs before schema validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tracemind-config-'));
    const file = join(directory, 'config.yaml');
    process.env.TRACEMIND_DATABASE_URL = 'postgresql://user:pass@localhost:5432/tracemind';
    await writeFile(file, 'server:\n  databaseUrl: ${TRACEMIND_DATABASE_URL}\n');
    try {
      const config = await loadConfig(file);
      expect(config.server.databaseUrl).toBe(process.env.TRACEMIND_DATABASE_URL);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses deployment environment variables to select an NVIDIA-compatible model without a config file', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-test-key';
    process.env.TRACEMIND_LLM_PROVIDER = 'openai-compatible';
    process.env.TRACEMIND_LLM_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
    process.env.TRACEMIND_LLM_API_BASE_URL = 'https://integrate.api.nvidia.com/v1';

    const directory = await mkdtemp(join(tmpdir(), 'tracemind-config-'));
    const absentConfig = join(directory, 'missing-config.yaml');
    try {
      const config = await loadConfig(absentConfig);
      expect(config.llm).toMatchObject({
        provider: 'openai-compatible',
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        apiBaseUrl: 'https://integrate.api.nvidia.com/v1',
      });
      expect(validateConfig(config).filter((error) => error.startsWith('AI model'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('lets deployment LLM environment values override file defaults without exposing the API key', async () => {
    process.env.NVIDIA_API_KEY = 'nvidia-test-key';
    process.env.TRACEMIND_LLM_PROVIDER = 'openai-compatible';
    process.env.TRACEMIND_LLM_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';
    process.env.TRACEMIND_LLM_API_BASE_URL = 'https://integrate.api.nvidia.com/v1';

    const directory = await mkdtemp(join(tmpdir(), 'tracemind-config-'));
    const file = join(directory, 'config.yaml');
    await writeFile(file, 'llm:\n  provider: openai\n  model: gpt-4o\n');
    try {
      const config = await loadConfig(file);
      expect(config.llm).toMatchObject({
        provider: 'openai-compatible',
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        apiBaseUrl: 'https://integrate.api.nvidia.com/v1',
      });
      expect(JSON.stringify(config)).not.toContain('nvidia-test-key');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
