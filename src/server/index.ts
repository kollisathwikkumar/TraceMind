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
import { connectFalkorDB, type FalkorDBConnection } from '../knowledge/store/falkordb-store';
import { MCPServer } from '../mcp/server';
import { createRouter } from './router';
import { IncidentStore } from './incidents/store';
import { WorkflowStore } from './workflows/store';
import type { RemediationExecutor } from './workflows/remediation';
import type { IncidentRepository } from './incidents/store';
import type { WorkflowRepository } from './workflows/store';
import { createPostgresStores } from './postgres-stores';
import { resolveAuth0Config, createAuth0TokenVerifier } from './auth0';
import { migrateProviderKeys, ProviderKeyStore } from './provider-keys';

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

  const effectiveConfig = config || (await loadConfig());

  // Create the local retriever (server always uses local storage)
  const retriever = await createConfiguredRetriever(baseDir, effectiveConfig);

  // The FalkorDB projection is optional so existing knowledge-server installs
  // continue to run unchanged. An explicitly configured but unreachable graph
  // fails startup instead of silently pretending graph features are active.
  let graphConnection: FalkorDBConnection | undefined;
  const graphUrl =
    process.env.TRACEMIND_FALKORDB_URL || process.env.RUNBOOK_FALKORDB_URL || effectiveConfig.graph.falkordbUrl;
  if (graphUrl) {
    graphConnection = await connectFalkorDB(graphUrl, effectiveConfig.graph.graphName);
  }

  const databaseUrl = resolveServerDatabaseUrl(effectiveConfig);
  let incidentStore: IncidentRepository;
  let workflowStore: WorkflowRepository;
  let closeDatabase: () => Promise<void>;
  let providerKeyStore: ProviderKeyStore | undefined;
  let databaseDriver: 'postgres' | 'sqlite';
  if (databaseUrl) {
    const stores = await createPostgresStores(databaseUrl);
    incidentStore = stores.incidentStore;
    workflowStore = stores.workflowStore;
    databaseDriver = 'postgres';
    if (process.env.TRACEMIND_CREDENTIAL_ENCRYPTION_KEY) {
      await migrateProviderKeys(stores.pool);
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

  const auth0Config = resolveAuth0Config();

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
    graphOrgId: effectiveConfig.graph.orgId,
    incidentStore,
    workflowStore,
    auth0Config,
    verifyAuth0Token: auth0Config ? createAuth0TokenVerifier(auth0Config) : undefined,
    providerKeyStore,
    databaseDriver,
    remediationExecutor: options.remediationExecutor,
  });
  const server = createServer(router);

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
    retriever.close();
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

export function resolveServerDatabaseUrl(
  config: Pick<Config, 'server'>,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  return environment.TRACEMIND_DATABASE_URL || environment.RUNBOOK_DATABASE_URL || config.server.databaseUrl;
}
