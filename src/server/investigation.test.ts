import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createOrchestrator, createLLMClient, getRuntimeTools, getAllTools, orchestrate } =
  vi.hoisted(() => ({
    createOrchestrator: vi.fn(),
    createLLMClient: vi.fn(),
    getRuntimeTools: vi.fn(),
    getAllTools: vi.fn(),
    orchestrate: vi.fn(),
  }));

vi.mock('../agent/investigation-orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/investigation-orchestrator')>()),
  createOrchestrator,
}));
vi.mock('../model/llm', () => ({ createLLMClient }));
vi.mock('../cli/runtime-tools', () => ({ getRuntimeTools }));
vi.mock('../tools/registry', () => ({ toolRegistry: { getAll: getAllTools } }));

import { createIncidentInvestigator } from './investigation';
import { DEFAULT_CONFIG } from '../utils/config';

describe('hosted incident investigator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    orchestrate.mockResolvedValue({ id: 'inv-1', summary: 'summary', durationMs: 5 });
    createOrchestrator.mockReturnValue({ investigate: orchestrate, on: vi.fn() });
    createLLMClient.mockReturnValue({
      chat: vi.fn().mockResolvedValue({ content: '{"ok":true}' }),
    });
    getAllTools.mockReturnValue([]);
    getRuntimeTools.mockImplementation(async () => [
      { name: 'aws_query', execute: vi.fn().mockResolvedValue({ logs: [] }) },
      { name: 'cloudwatch_logs', execute: vi.fn().mockResolvedValue({ logs: [] }) },
      { name: 'aws_mutate', execute: vi.fn() },
      { name: 'skill', execute: vi.fn() },
    ]);
  });

  it('uses only read-only tools, tenant-scoped evidence, and proposal-only remediation settings', async () => {
    const signal = new AbortController().signal;
    const awsQueryExecute = vi.fn().mockResolvedValue({ logs: [] });
    getRuntimeTools.mockResolvedValue([
      { name: 'aws_query', execute: awsQueryExecute },
      { name: 'cloudwatch_logs', execute: vi.fn().mockResolvedValue({ logs: [] }) },
      { name: 'aws_mutate', execute: vi.fn() },
      { name: 'skill', execute: vi.fn() },
    ]);
    const search = vi.fn().mockResolvedValue({
      runbooks: [
        {
          title: 'Database saturation',
          sourceUrl: 'https://docs.example/runbook',
          content: 'Reduce queue depth safely.',
        },
      ],
    });
    const findIncidentEvidencePaths = vi.fn().mockResolvedValue([
      {
        rationale: 'Prior incidents share service payments',
        services: [{ id: 'payments', name: 'Payments' }],
        edges: [{ from: 'payments', to: 'database', relationship: 'DEPENDS_ON' }],
      },
    ]);
    const graphStore = { findIncidentEvidencePaths };
    const investigator = createIncidentInvestigator({
      config: DEFAULT_CONFIG,
      retrieverForTenant: async () => ({ search, close: vi.fn() }) as never,
      graphStore: graphStore as never,
    });
    const incident = {
      id: 'incident-1',
      title: 'Checkout latency',
      description: 'p95 increased',
      severity: 'SEV-2',
      status: 'open',
      assignee: null,
      createdAt: '',
      updatedAt: '',
    } as const;
    const result = await investigator({
      incident: incident as never,
      tenantId: 'org-a',
      additionalContext: 'gateway logs',
      priorMemory: ['prior summary'],
    });

    expect(result.id).toBe('inv-1');
    expect(createLLMClient).toHaveBeenCalledWith(
      expect.objectContaining({ requestTimeoutMs: 45_000 })
    );
    const [llm, executor, options] = createOrchestrator.mock.calls[0];
    expect(options).toMatchObject({
      incidentId: 'incident-1',
      autoApproveRemediation: false,
      availableTools: ['aws_query', 'cloudwatch_logs'],
      availableSkills: [],
    });
    expect(options.availableTools).not.toContain('aws_mutate');
    expect(options.availableTools).not.toContain('skill');

    await expect(executor.execute('aws_mutate', {}, { signal })).rejects.toThrow(
      'Read-only investigation tool unavailable'
    );
    await executor.execute('aws_query', { query: 'read only' }, { signal });
    expect(awsQueryExecute).toHaveBeenCalledWith({ query: 'read only' }, { signal });
    const completions = await llm.complete('prompt');
    expect(completions).toBe('{"ok":true}');
    const runbookContext = await options.fetchRelevantRunbooks({
      rootCause: 'db',
      affectedServices: ['payments'],
      signal,
    });
    expect(search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        typeFilter: ['runbook'],
        limit: 8,
        signal,
      })
    );
    expect(runbookContext[0]).toContain('Database saturation');
    const graphContext = await options.fetchGraphContext({
      incidentId: 'incident-1',
      query: 'checkout',
      signal,
    });
    expect(graphContext[0]).toContain('does not establish causality');
    expect(findIncidentEvidencePaths).toHaveBeenCalledWith('org-a', 'incident-1', 3, signal);
    expect(orchestrate).toHaveBeenCalledWith(
      'Checkout latency\np95 increased',
      expect.stringContaining('prior summary')
    );

    const aborted = new AbortController();
    aborted.abort();
    const searchCallCount = search.mock.calls.length;
    await expect(
      executor.execute('aws_query', { query: 'read only' }, { signal: aborted.signal })
    ).rejects.toThrow('Investigation cancelled');
    await expect(
      options.fetchRelevantRunbooks({
        rootCause: 'db',
        affectedServices: [],
        signal: aborted.signal,
      })
    ).rejects.toThrow('Investigation cancelled');
    await expect(
      options.fetchGraphContext({
        incidentId: 'incident-1',
        query: 'checkout',
        signal: aborted.signal,
      })
    ).rejects.toThrow('Investigation cancelled');
    expect(awsQueryExecute).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledTimes(searchCallCount);
    expect(findIncidentEvidencePaths).toHaveBeenCalledTimes(1);
  });
});
