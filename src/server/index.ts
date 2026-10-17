/**
 * TraceMind incident intelligence API
 *
 * Starts an HTTP server exposing the knowledge API and MCP endpoint.
 * Usage: tracemind server --port 4000 --api-key <key>
 */

import { createServer } from 'http';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { loadConfig, type Config } from '../utils/config';
import { createConfiguredRetriever } from '../knowledge/retriever/index';
import type { IKnowledgeRetriever } from '../knowledge/retriever/types';
import { connectFalkorDB, type FalkorDBConnection } from '../knowledge/store/falkordb-store';
import { PostgresKnowledgeStore, migratePostgresKnowledge } from '../knowledge/store/postgres';
import {
  PostgresVectorStore,
  migratePostgresVectorStore,
} from '../knowledge/store/postgres-vector-store';
import { MCPServer } from '../mcp/server';
import { createRouter } from './router';
import { IncidentStore } from './incidents/store';
import { WorkflowStore } from './workflows/store';
import type { RemediationExecutor } from './workflows/remediation';
import type { IncidentRepository } from './incidents/store';
import type { WorkflowRepository } from './workflows/store';
import { createPostgresStores } from './postgres-stores';
import { migrateGraphCatalog, PostgresGraphCatalogStore } from './graph-catalog';
import { resolveAuth0Config, createAuth0TokenVerifier } from './auth0';
import { migrateProviderKeys, ProviderKeyStore } from './provider-keys';
import { resolveRemediationExecutor } from './workflows/http-executor';

export interface ServerOptions {
  port: number;
  host: string;
  baseDir: string;
  apiKey: string;
  config?: Config;
  remediationExecutor?: RemediationExecutor;
}

export async function startServer(options: ServerOptions): Promise<void> {
  const { port, host, baseDir, apiKey, config } = options;
  validateServerApiKey(apiKey);

  // Resolve remediation configuration before opening database connections or
  // binding the listener. In required mode, a missing broker must fail startup.
  const { executor: remediationExecutor, required: remediationExecutorRequired } =
    resolveRemediationExecutor(options.remediationExecutor);

  const effectiveConfig = config || (await loadConfig());
  validateRequiredBackendConfiguration(effectiveConfig);
  const auth0Config = resolveAuth0Config();
  const graphConfig = resolveGraphConfig(effectiveConfig);

  const databaseUrl = resolveServerDatabaseUrl(effectiveConfig);
  if (auth0Config && graphConfig.orgIds.length > 1 && !databaseUrl) {
    throw new Error('Multiple Auth0 organizations require PostgreSQL-backed tenant storage');
  }
  const stores = databaseUrl ? await createPostgresStores(databaseUrl) : undefined;
  if (stores) {
    await migratePostgresKnowledge(stores.migrationPool, stores.runtimeRole);
    await migratePostgresVectorStore(stores.migrationPool, stores.runtimeRole);
  }

  const tenantRetrievers = new Map<string, Promise<IKnowledgeRetriever>>();
  const localRetriever = stores
    ? undefined
    : await createConfiguredRetriever(baseDir, effectiveConfig);
  const getTenantRetriever = async (tenantId: string): Promise<IKnowledgeRetriever> => {
    if (!stores) return localRetriever!;
    let pending = tenantRetrievers.get(tenantId);
    if (!pending) {
      pending = createConfiguredRetriever(baseDir, effectiveConfig, {
        knowledge: new PostgresKnowledgeStore(stores.pool, tenantId, false),
        vector: new PostgresVectorStore(stores.pool, { tenantId }),
      });
      tenantRetrievers.set(tenantId, pending);
      pending.catch(() => tenantRetrievers.delete(tenantId));
    }
    return pending;
  };
  const retriever = stores ? await getTenantRetriever(graphConfig.orgId) : localRetriever!;

  // The FalkorDB projection is optional so existing knowledge-server installs
  // continue to run unchanged. An explicitly configured but unreachable graph
  // fails startup instead of silently pretending graph features are active.
  let graphConnection: FalkorDBConnection | undefined;
  if (graphConfig.url) {
    graphConnection = await connectFalkorDB(graphConfig.url, graphConfig.graphName);
  }

  let incidentStore: IncidentRepository;
  let workflowStore: WorkflowRepository;
  let closeDatabase: () => Promise<void>;
  let providerKeyStore: ProviderKeyStore | undefined;
  let graphOutbox: Awaited<ReturnType<typeof createPostgresStores>>['graphOutbox'] | undefined;
  let graphCatalogStore: PostgresGraphCatalogStore | undefined;
  let databaseDriver: 'postgres' | 'sqlite';
  if (stores) {
    incidentStore = stores.incidentStore;
    workflowStore = stores.workflowStore;
    graphOutbox = stores.graphOutbox;
    if (graphConnection?.store) {
      await migrateGraphCatalog(stores.migrationPool, stores.runtimeRole);
      graphCatalogStore = new PostgresGraphCatalogStore(stores.pool, graphConfig.orgId);
    }
    databaseDriver = 'postgres';
    if (process.env.TRACEMIND_CREDENTIAL_ENCRYPTION_KEY) {
      await migrateProviderKeys(stores.migrationPool);
      providerKeyStore = new ProviderKeyStore(stores.pool);
    }
    closeDatabase = stores.close;
  } else {
    const incidentPath = join(baseDir, 'incidents.sqlite');
    mkdirSync(dirname(incidentPath), { recursive: true });
    const sqliteIncidents = new IncidentStore(incidentPath);
    const sqliteWorkflows = new WorkflowStore(incidentPath);
    incidentStore = sqliteIncidents;
    workflowStore = sqliteWorkflows;
    databaseDriver = 'sqlite';
    closeDatabase = async () => {
      sqliteIncidents.close();
      sqliteWorkflows.close();
    };
  }

  const reconciliationTenants = [...new Set([graphConfig.orgId, ...graphConfig.orgIds])];
  const reconcileLeases = async () => {
    await Promise.all(
      reconciliationTenants.map((tenantId) =>
        workflowStore.reconcileExpiredLeases('system:lease-reconciler', new Date(), tenantId)
      )
    );
  };
  await reconcileLeases();

  // Create MCP server and inject the retriever
  const mcpServer = new MCPServer({ baseDir });
  mcpServer.setRetriever(retriever);

  // Read version from package.json (best-effort)
  let version = '0.0.0';
  try {
    const pkg = await import('../../package.json', { with: { type: 'json' } });
    version = pkg.default.version || version;
  } catch {
    // Fallback is fine
  }

  const router = createRouter({
    apiKey,
    retriever,
    mcpServer,
    version,
    config: effectiveConfig,
    graphStore: graphConnection?.store,
    graphOrgId: graphConfig.orgId,
    auth0OrgIds: graphConfig.orgIds,
    graphOutbox: graphConnection?.store ? graphOutbox : undefined,
    graphCatalogStore,
    incidentStore,
    workflowStore,
    auth0Config,
    verifyAuth0Token: auth0Config ? createAuth0TokenVerifier(auth0Config) : undefined,
    providerKeyStore,
    databaseDriver,
    remediationExecutor,
    retrieverForTenant: getTenantRetriever,
    remediationExecutorRequired,
    buildSha: resolveBuildSha(),
  });
  const server = createServer(router);

  const graphReplayTimer =
    graphConnection?.store && (graphCatalogStore || graphOutbox)
      ? setInterval(() => {
          for (const tenantId of reconciliationTenants) {
            if (graphCatalogStore) {
              void graphCatalogStore.replay(graphConnection!.store, tenantId).catch((error) => {
                console.error('Graph catalog outbox replay failed', error instanceof Error ? error.message : 'unknown error');
              });
            }
            if (graphOutbox) {
              void graphOutbox.replay(graphConnection!.store, tenantId).catch((error) => {
                console.error('Legacy graph projection outbox replay failed', error instanceof Error ? error.message : 'unknown error');
              });
            }
          }
        }, 2_000)
      : undefined;
  graphReplayTimer?.unref();

  // Reconcile leases that expire while this process remains online as well as at startup.
  // Unknown outcomes remain non-executable and require a separate operator resolution flow.
  const leaseReconciliationTimer = setInterval(() => {
    void reconcileLeases().catch((error) => {
      console.error(
        'Remediation lease reconciliation failed',
        error instanceof Error ? error.message : 'unknown error'
      );
    });
  }, 30_000);
  leaseReconciliationTimer.unref();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nShutting down...');
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    // Force exit after 5s if a request or client fails to drain.
    setTimeout(() => process.exit(1), 5000).unref();
    await serverClosed;
    if (graphReplayTimer) clearInterval(graphReplayTimer);
    clearInterval(leaseReconciliationTimer);
    for (const tenantRetriever of tenantRetrievers.values()) {
      (await tenantRetriever).close();
    }
    if (tenantRetrievers.size === 0) retriever.close();
    await closeDatabase();
    await graphConnection?.close();
    mcpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      console.log(`TraceMind server listening on http://${host}:${port}`);
      console.log(`  Health:  http://${host}:${port}/api/v1/health`);
      console.log(`  API:     http://${host}:${port}/api/v1/knowledge/...`);
      console.log(`  MCP:     http://${host}:${port}/mcp`);
      console.log(`  Admin:   http://${host}:${port}/admin`);
      resolve();
    });
  });
}

export function validateServerApiKey(apiKey: string): void {
  if (/\s/.test(apiKey)) throw new Error('Server API key must not contain whitespace');
  if (Buffer.byteLength(apiKey, 'utf8') < 32) {
    throw new Error('Server API key must contain at least 32 bytes');
  }
}

export function resolveGraphConfig(
  config: Pick<Config, 'graph'>,
  environment: NodeJS.ProcessEnv = process.env
): { url: string | undefined; graphName: string; orgId: string; orgIds: string[] } {
  const orgId = environment.TRACEMIND_ORG_ID || config.graph.orgId;
  const configuredOrgIds = (environment.TRACEMIND_ORG_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    url:
      environment.TRACEMIND_FALKORDB_URL ||
      environment.RUNBOOK_FALKORDB_URL ||
      config.graph.falkordbUrl,
    graphName: environment.TRACEMIND_FALKORDB_GRAPH_NAME || config.graph.graphName,
    orgId,
    orgIds: configuredOrgIds.length ? [...new Set(configuredOrgIds)] : [orgId],
  };
}

function resolveBuildSha(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.RENDER_GIT_COMMIT || environment.GIT_COMMIT_SHA;
  return value?.trim() || undefined;
}

export function resolveServerDatabaseUrl(
  config: Pick<Config, 'server'>,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  return (
    environment.TRACEMIND_DATABASE_URL ||
    environment.RUNBOOK_DATABASE_URL ||
    config.server.databaseUrl
  );
}

/** Fail closed when a deployment explicitly requires shared PostgreSQL and graph storage. */
export function validateRequiredBackendConfiguration(
  config: Pick<Config, 'server' | 'graph'>,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const required = (name: string): boolean => {
    const value = environment[name]?.trim().toLowerCase();
    if (value === undefined || value === '' || value === 'false') return false;
    if (value === 'true') return true;
    throw new Error(`${name} must be true or false`);
  };

  if (required('TRACEMIND_REQUIRE_POSTGRES') && !resolveServerDatabaseUrl(config, environment)) {
    throw new Error('TRACEMIND_REQUIRE_POSTGRES is true but no PostgreSQL URL is configured');
  }

  if (required('TRACEMIND_REQUIRE_FALKORDB') && !resolveGraphConfig(config, environment).url) {
    throw new Error('TRACEMIND_REQUIRE_FALKORDB is true but no FalkorDB URL is configured');
  }
}
