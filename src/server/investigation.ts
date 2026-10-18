import {
  createOrchestrator,
  InvestigationAbortError,
  InvestigationOperationTimeoutError,
  OutstandingWorkTracker,
  type InvestigationOperationEvent,
  type InvestigationResult,
} from '../agent/investigation-orchestrator';
import { getRuntimeTools } from '../cli/runtime-tools';
import { createLLMClient } from '../model/llm';
import type { FalkorDBStore } from '../knowledge/store/falkordb-store';
import type { IKnowledgeRetriever } from '../knowledge/retriever/types';
import { toolRegistry } from '../tools/registry';
import type { Config } from '../utils/config';
import type { Incident } from './incidents/store';

const READ_ONLY_TOOLS = new Set([
  'aws_query',
  'cloudwatch_alarms',
  'cloudwatch_logs',
  'datadog',
  'prometheus',
]);

export const hostedInvestigationWorkTracker = new OutstandingWorkTracker(32);

export function closeHostedInvestigationWork(): void {
  hostedInvestigationWorkTracker.close();
}

export function drainHostedInvestigationWork(timeoutMs: number): Promise<boolean> {
  return hostedInvestigationWorkTracker.drain(timeoutMs);
}

/** Races non-signal-aware setup/DB work while retaining its promise until it settles. */
export async function runTrackedHostedOperation<T>(
  operation: string,
  start: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 10_000,
  traceId?: string
): Promise<T> {
  if (signal?.aborted) {
    const deadline =
      (signal.reason as { code?: string } | undefined)?.code === 'investigation_deadline';
    throw new InvestigationAbortError(
      deadline ? 'deadline' : 'cancelled',
      hostedInvestigationWorkTracker.pendingCount,
      deadline ? 'Investigation deadline exceeded' : 'Investigation cancelled'
    );
  }
  const tracked = hostedInvestigationWorkTracker.track(operation, start, (event) => {
    console.info(
      JSON.stringify({
        event: `tracemind.investigation_${event.type}`,
        traceId,
        operation: event.operation,
        durationMs: event.durationMs,
        ...(event.type === 'operation_timing' ? { outcome: event.outcome } : {}),
        ...(event.type !== 'operation_timing' ? { pendingCount: event.pendingCount } : {}),
      })
    );
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      const deadline =
        (signal?.reason as { code?: string } | undefined)?.code === 'investigation_deadline';
      const error = new InvestigationAbortError(
        deadline ? 'deadline' : 'cancelled',
        hostedInvestigationWorkTracker.pendingCount,
        deadline ? 'Investigation deadline exceeded' : 'Investigation cancelled'
      );
      tracked.abandon();
      reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      const error = new InvestigationOperationTimeoutError(
        operation,
        hostedInvestigationWorkTracker.pendingCount
      );
      tracked.abandon();
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([tracked.promise, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Runs the existing investigation orchestrator for an HTTP-submitted incident.
 * Its tool set is explicitly read-only and remediation is only proposed.
 */
export function createIncidentInvestigator(options: {
  config: Config;
  retrieverForTenant: (tenantId: string) => Promise<IKnowledgeRetriever>;
  graphStore?: FalkorDBStore;
  workTracker?: OutstandingWorkTracker;
}): (input: {
  incident: Incident;
  tenantId: string;
  additionalContext?: string;
  priorMemory?: string[];
  signal?: AbortSignal;
  traceId?: string;
}) => Promise<InvestigationResult> {
  return async ({ incident, tenantId, additionalContext, priorMemory = [], signal, traceId }) => {
    const llm = createLLMClient({
      ...options.config.llm,
      requestTimeoutMs: 45_000,
    });
    const configuredTools = await runTrackedHostedOperation(
      'investigation:runtime_tools',
      () => getRuntimeTools(options.config, toolRegistry.getAll()),
      signal,
      10_000,
      traceId
    );
    const runtimeTools = configuredTools.filter((tool) => READ_ONLY_TOOLS.has(tool.name));
    const toolsByName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
    const retriever = await runTrackedHostedOperation(
      'investigation:tenant_retriever',
      () => options.retrieverForTenant(tenantId),
      signal,
      10_000,
      traceId
    );
    const query = `${incident.title}\n${incident.description}`.trim().slice(0, 5_000);

    const orchestrator = createOrchestrator(
      {
        complete: async (prompt, callOptions) => {
          const response = await llm.chat(
            'You are an SRE investigator. Return only valid JSON matching the requested schema.',
            prompt,
            undefined,
            { signal: callOptions?.signal ?? signal }
          );
          return response.content;
        },
      },
      {
        execute: async (toolName, parameters, callOptions) => {
          const tool = toolsByName.get(toolName);
          if (!tool) throw new Error(`Read-only investigation tool unavailable: ${toolName}`);
          if (callOptions?.signal?.aborted) throw new Error('Investigation cancelled');
          return tool.execute(parameters, { signal: callOptions?.signal });
        },
      },
      {
        incidentId: incident.id,
        maxIterations: Math.max(1, Math.min(options.config.agent.maxIterations, 8)),
        autoApproveRemediation: false,
        signal,
        totalDeadlineMs: 90_000,
        integrationTimeoutMs: 15_000,
        outstandingWorkTracker: options.workTracker ?? hostedInvestigationWorkTracker,
        availableTools: runtimeTools.map((tool) => tool.name),
        availableSkills: [],
        fetchRelevantRunbooks: async ({ rootCause, affectedServices, signal: operationSignal }) => {
          if (operationSignal?.aborted) throw new Error('Investigation cancelled');
          const result = await retriever.search(
            [rootCause, ...affectedServices].join(' ').slice(0, 2_000) || incident.title,
            {
              typeFilter: ['runbook'],
              serviceFilter: affectedServices.length ? affectedServices : undefined,
              limit: 8,
              signal: operationSignal,
            }
          );
          return result.runbooks.slice(0, 8).map((runbook) => {
            const source = runbook.sourceUrl ? ` (${runbook.sourceUrl})` : '';
            return `${runbook.title}${source}: ${runbook.content.slice(0, 800)}`;
          });
        },
        fetchGraphContext: async ({ incidentId, signal: operationSignal }) => {
          if (!options.graphStore || !incidentId) return [];
          if (operationSignal?.aborted) throw new Error('Investigation cancelled');
          const paths = await options.graphStore.findIncidentEvidencePaths(
            tenantId,
            incidentId,
            3,
            operationSignal
          );
          return paths.slice(0, 8).map((path) => {
            const services = path.services
              .map((service) => `${service.name} [${service.id}]`)
              .join(' → ');
            const edges = path.edges
              .map((edge) => `${edge.from} -[${edge.relationship}]-> ${edge.to}`)
              .join(' | ');
            return `${path.rationale} Services: ${services}. Edges: ${edges}. Graph correlation does not establish causality.`;
          });
        },
      }
    );

    orchestrator.on((event) => {
      if (isOperationEvent(event)) {
        console.info(
          JSON.stringify({
            event: `tracemind.investigation_${event.type}`,
            traceId,
            operation: event.operation,
            durationMs: event.durationMs,
            ...(event.type === 'operation_timing' ? { outcome: event.outcome } : {}),
            ...(event.type !== 'operation_timing' ? { pendingCount: event.pendingCount } : {}),
          })
        );
      }
    });

    const memoryContext = priorMemory.slice(0, 5).map((entry) => entry.slice(0, 2_000));
    const context = [
      additionalContext?.trim().slice(0, 8_000),
      memoryContext.length
        ? `Prior incident investigations:\n${memoryContext.join('\n---\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 10_000);
    return orchestrator.investigate(
      query || `Investigate incident ${incident.id}`,
      context || undefined
    );
  };
}

function isOperationEvent(event: unknown): event is InvestigationOperationEvent {
  if (!event || typeof event !== 'object') return false;
  const type = (event as { type?: unknown }).type;
  return (
    type === 'operation_timing' ||
    type === 'operation_unfinished' ||
    type === 'operation_late_settled'
  );
}
