/**
 * HTTP API Router
 *
 * Routes incoming requests to the appropriate handler.
 * Uses raw http.createServer (no framework), following the same
 * pattern as src/webhooks/slack-webhook.ts.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { IKnowledgeRetriever } from '../knowledge/retriever/types';
import type { KnowledgeDocument, KnowledgeType } from '../knowledge/types';
import type { Config } from '../utils/config';
import { LLMValidationError, validateLLMProvider } from './llm-validation';
import type { MCPServer } from '../mcp/server';
import type { FalkorDBStore } from '../knowledge/store/falkordb-store';
import type { IncidentRepository, IncidentSeverity, IncidentStatus } from './incidents/store';
import {
  type WorkflowRepository,
  type EvaluationCaseInput,
  type RemediationStepInput,
} from './workflows/store';
import { RemediationWorkflow, type RemediationExecutor } from './workflows/remediation';
import { handleMcpRequest } from './mcp-transport';
import type { Auth0Config, Auth0Identity } from './auth0';
import type { ProviderKeyStorePort } from './provider-keys';
import type { GraphProjectionEvent } from './postgres-stores';
import type { PostgresGraphCatalogStore } from './graph-catalog';
import {
  authenticateRequest,
  readBody,
  RequestBodyTooLargeError,
  sendJson,
  serveAdminFile,
  serveLaunchFile,
} from './utils';

export interface RouterConfig {
  apiKey: string;
  retriever: IKnowledgeRetriever;
  retrieverForTenant?: (tenantId: string) => Promise<IKnowledgeRetriever>;
  mcpServer: MCPServer;
  version: string;
  config: Config;
  graphStore?: FalkorDBStore;
  graphOrgId?: string;
  /** Auth0 organization allowlist; when omitted, the configured legacy org is the only tenant. */
  auth0OrgIds?: string[];
  graphOutbox?: {
    enqueue(event: GraphProjectionEvent): Promise<string>;
    checkHealth?(orgId: string): Promise<number>;
  };
  graphCatalogStore?: Pick<
    PostgresGraphCatalogStore,
    | 'upsertService'
    | 'linkDependency'
    | 'linkIncidentToService'
    | 'linkIncidentToServices'
    | 'unlinkDependency'
    | 'unlinkIncidentFromService'
    | 'deleteService'
    | 'reconcile'
    | 'checkHealth'
  >;
  incidentStore?: IncidentRepository;
  workflowStore?: WorkflowRepository;
  auth0Config?: Auth0Config;
  verifyAuth0Token?: (token: string) => Promise<Auth0Identity | undefined>;
  providerKeyStore?: ProviderKeyStorePort;
  databaseDriver?: 'postgres' | 'sqlite';
  remediationExecutor?: RemediationExecutor;
  /** Fail readiness when remediation is required but no executor is configured. */
  remediationExecutorRequired?: boolean;
  /** Immutable source revision supplied by the deployment platform. */
  buildSha?: string;
  /** Maximum time a readiness dependency may take before it is unhealthy. */
  healthCheckTimeoutMs?: number;
  /** Override the provider request in route-level tests. */
  validateLLM?: () => Promise<{ content: string }>;
}

export function createRouter(routerConfig: RouterConfig) {
  const {
    apiKey,
    retriever,
    mcpServer,
    version,
    config,
    graphStore,
    incidentStore,
    workflowStore,
  } = routerConfig;
  const remediation = new RemediationWorkflow(
    workflowStore as WorkflowRepository,
    routerConfig.remediationExecutor
  );
  const graphOrgId = routerConfig.graphOrgId || 'default';
  const auth0OrgIds = new Set(
    routerConfig.auth0OrgIds?.length ? routerConfig.auth0OrgIds : [graphOrgId]
  );
  const startTime = Date.now();

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method || 'GET';

    // Apply the configured browser policy consistently before any route writes headers.
    const cors = config.server.cors;
    const origin = req.headers.origin;
    if (cors.enabled && origin) {
      const allowed = cors.origins.includes('*') || cors.origins.includes(origin);
      if (!allowed) {
        sendJson(res, 403, { error: { code: 'cors_forbidden', message: 'Origin is not allowed' } });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', cors.origins.includes('*') ? '*' : origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    const adminAuth0Origin =
      /^\/admin(?:\/|$)/.test(path) && routerConfig.auth0Config
        ? new URL(routerConfig.auth0Config.issuer).origin
        : undefined;
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'${adminAuth0Origin ? ` ${adminAuth0Origin}` : ''}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`
    );
    if (method === 'OPTIONS' && cors.enabled) {
      res.writeHead(204);
      res.end();
      return;
    }

    // Liveness is process-only. Readiness is bounded and verifies dependencies.
    if (path === '/livez' && (method === 'GET' || method === 'HEAD')) {
      sendProbe(res, 200, { status: 'alive' }, method);
      return;
    }
    if (
      (path === '/readyz' || path === '/api/v1/health') &&
      (method === 'GET' || method === 'HEAD')
    ) {
      const timeoutMs = routerConfig.healthCheckTimeoutMs ?? 2_000;
      const [incidentResult, workflowResult, graphResult, graphProjectionPending, knowledgeHealth] =
        await Promise.all([
          incidentStore
            ? withTimeout(Promise.resolve(incidentStore.checkHealth()), timeoutMs)
                .then(() => true)
                .catch(() => false)
            : Promise.resolve(false),
          workflowStore
            ? withTimeout(Promise.resolve(workflowStore.checkHealth()), timeoutMs)
                .then(() => true)
                .catch(() => false)
            : Promise.resolve(false),
          graphStore
            ? withTimeout(Promise.resolve(graphStore.checkHealth()), timeoutMs)
                .then(() => true)
                .catch(() => false)
            : Promise.resolve(true),
          routerConfig.graphCatalogStore || routerConfig.graphOutbox?.checkHealth
            ? withTimeout(
                Promise.all(
                  [...new Set([graphOrgId, ...(routerConfig.auth0OrgIds ?? [])])].map(
                    async (orgId) => {
                      const [catalogPending, legacyPending] = await Promise.all([
                        routerConfig.graphCatalogStore?.checkHealth(orgId) ?? 0,
                        routerConfig.graphOutbox?.checkHealth?.(orgId) ?? 0,
                      ]);
                      return catalogPending + legacyPending;
                    }
                  )
                ),
                timeoutMs
              )
                .then((pendingByTenant) => pendingByTenant.reduce((sum, count) => sum + count, 0))
                .catch(() => undefined)
            : Promise.resolve(undefined),
          retriever.checkHealth
            ? withTimeout(retriever.checkHealth(), timeoutMs).catch(() => null)
            : Promise.resolve(undefined),
        ]);
      const postgresKnowledgeRequired = routerConfig.databaseDriver === 'postgres';
      const knowledgeStoreHealthy = knowledgeHealth?.knowledgeStore === true;
      const vectorStoreHealthy = knowledgeHealth?.vectorStore === true;
      const components = {
        incidentStore: incidentResult ? 'healthy' : incidentStore ? 'unhealthy' : 'missing',
        workflowStore: workflowResult ? 'healthy' : workflowStore ? 'unhealthy' : 'missing',
        graphStore: graphStore
          ? graphResult
            ? 'healthy'
            : 'unhealthy'
          : 'optional_not_configured',
        graphProjection:
          routerConfig.graphCatalogStore || routerConfig.graphOutbox?.checkHealth
            ? graphProjectionPending === undefined
              ? 'unhealthy'
              : 'healthy'
            : 'optional_not_configured',
        knowledgeStore: knowledgeHealth
          ? knowledgeStoreHealthy
            ? 'healthy'
            : 'unhealthy'
          : knowledgeHealth === null
            ? 'unhealthy'
            : postgresKnowledgeRequired
              ? 'missing'
              : 'optional_not_configured',
        vectorStore:
          knowledgeHealth === null
            ? 'unhealthy'
            : knowledgeHealth?.vectorStore !== undefined
              ? vectorStoreHealthy
                ? 'healthy'
                : 'unhealthy'
              : postgresKnowledgeRequired
                ? 'missing'
                : 'optional_not_configured',
        remediationExecutor: routerConfig.remediationExecutor
          ? 'configured'
          : routerConfig.remediationExecutorRequired
            ? 'required_not_configured'
            : 'optional_not_configured',
      };
      const ready =
        incidentResult &&
        workflowResult &&
        graphResult &&
        ((knowledgeHealth === undefined && !postgresKnowledgeRequired) || knowledgeStoreHealthy) &&
        ((knowledgeHealth?.vectorStore === undefined && !postgresKnowledgeRequired) ||
          vectorStoreHealthy) &&
        (!(routerConfig.graphCatalogStore || routerConfig.graphOutbox?.checkHealth) ||
          graphProjectionPending !== undefined) &&
        (!routerConfig.remediationExecutorRequired || Boolean(routerConfig.remediationExecutor));
      const payload = {
        data: {
          status: ready ? 'ready' : 'not_ready',
          components,
          ...(graphProjectionPending === undefined ? {} : { graphProjectionPending }),
          database: routerConfig.databaseDriver || 'unknown',
          version,
          ...(routerConfig.buildSha ? { buildSha: routerConfig.buildSha } : {}),
          uptime: Math.floor((Date.now() - startTime) / 1000),
        },
      };
      if (method === 'HEAD') sendProbe(res, ready ? 200 : 503, payload.data, method);
      else sendJson(res, ready ? 200 : 503, payload);
      return;
    }

    // Public probes must not depend on Auth0/JWKS availability. Resolve the
    // tenant only after liveness/readiness have returned.
    const identity = await resolveRequestIdentity(req, apiKey, routerConfig.verifyAuth0Token);
    const actor = requestActor(identity);
    // Auth0 Organizations provide the authenticated tenant. Shared/local API keys
    // remain intentionally single-tenant and use the configured server tenant.
    const tenantId = identity?.kind === 'auth0' ? identity.organizationId || '' : graphOrgId;

    // Public Auth0 settings contain only values intended for the browser.
    if (path === '/api/v1/auth/config' && method === 'GET') {
      const auth0 = routerConfig.auth0Config;
      sendJson(res, 200, {
        data: auth0
          ? {
              enabled: true,
              domain: auth0.domain,
              clientId: auth0.clientId,
              audience: auth0.audience,
              // `default` is a TraceMind storage fallback, not an Auth0
              // organization ID and must never be sent as the OAuth parameter.
              organizations: [...auth0OrgIds].filter(
                (organizationId) => organizationId !== 'default'
              ),
            }
          : { enabled: false, localAccess: isLocalBrowserRequest(req) },
      });
      return;
    }

    // The admin login uses this protected endpoint to verify a bearer key.
    // Keep /health public for load balancers and process monitoring.
    if (path === '/api/v1/auth/validate' && method === 'GET') {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }
      sendJson(res, 200, { data: { authenticated: true } });
      return;
    }

    const requiredScope = requiredScopeFor(path, method);
    if (requiredScope && identity?.kind === 'auth0') {
      if (!identity.organizationId) {
        sendJson(res, 403, {
          error: {
            code: 'tenant_required',
            message: 'Auth0 token must include an organization claim',
          },
        });
        return;
      }
      if (!auth0OrgIds.has(identity.organizationId)) {
        sendJson(res, 403, {
          error: {
            code: 'tenant_forbidden',
            message: 'Token organization is not enabled for this service',
          },
        });
        return;
      }
      if (!hasRequiredScope(identity, requiredScope, path, method)) {
        sendJson(res, 403, {
          error: { code: 'insufficient_scope', message: `Required permission: ${requiredScope}` },
        });
        return;
      }
    }

    if (path === '/api/v1/settings/provider-key' && ['GET', 'PUT', 'DELETE'].includes(method)) {
      if (identity?.kind !== 'auth0') {
        sendJson(res, 401, {
          error: { code: 'auth0_required', message: 'Sign in to manage a personal provider key' },
        });
        return;
      }
      if (!routerConfig.providerKeyStore) {
        sendJson(res, 503, {
          error: {
            code: 'provider_key_store_unavailable',
            message:
              'Configure PostgreSQL and TRACEMIND_CREDENTIAL_ENCRYPTION_KEY to save personal keys',
          },
        });
        return;
      }
      try {
        if (method === 'GET') {
          sendJson(res, 200, { data: await routerConfig.providerKeyStore.getStatus(identity.sub) });
          return;
        }
        if (method === 'DELETE') {
          await routerConfig.providerKeyStore.delete(identity.sub);
          sendJson(res, 200, { data: { configured: false } });
          return;
        }
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
        const apiKeyValue = typeof body.apiKey === 'string' ? body.apiKey : '';
        if (
          !/^[a-zA-Z0-9._-]{1,80}$/.test(provider) ||
          !apiKeyValue.trim() ||
          apiKeyValue.length > 4096
        ) {
          sendJson(res, 400, {
            error: {
              code: 'invalid_provider_key',
              message: 'Provide a valid provider and API key (up to 4096 characters)',
            },
          });
          return;
        }
        await routerConfig.providerKeyStore.save(identity.sub, provider, apiKeyValue);
        sendJson(res, 200, { data: await routerConfig.providerKeyStore.getStatus(identity.sub) });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          sendJson(res, 413, {
            error: { code: 'payload_too_large', message: 'Request body exceeds 1 MB limit' },
          });
          return;
        }
        sendJson(res, 400, {
          error: { code: 'invalid_provider_key', message: 'Provider key could not be saved' },
        });
      }
      return;
    }

    // Make a small, fixed inference request so operators can distinguish a
    // configured model provider from the separate TraceMind admin API key.
    if (path === '/api/v1/llm/validate' && method === 'POST') {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }
      try {
        const validation = routerConfig.validateLLM
          ? { ...(await routerConfig.validateLLM()), usedFallback: false }
          : await validateLLMProvider(config);
        const result = validation;
        const response = result.content.trim();
        if (!response) throw new Error('Empty model response');
        sendJson(res, 200, {
          data: {
            status: 'connected',
            provider: config.llm.provider,
            model: config.llm.model,
            response: response.slice(0, 2000),
            usedFallback: validation.usedFallback,
            checkedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        // Do not echo provider exceptions: SDK errors may contain request
        // metadata, including credential-bearing headers or URLs.
        sendJson(res, 502, {
          error: {
            code: 'llm_validation_failed',
            message:
              error instanceof LLMValidationError
                ? error.message
                : 'Provider test request failed. Check the configured key, model, endpoint, and provider availability.',
          },
        });
      }
      return;
    }

    // MCP endpoint
    if (path === '/mcp') {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }
      if (identity.kind === 'auth0') {
        sendJson(res, 503, {
          error: {
            code: 'tenant_mcp_unavailable',
            message: 'MCP does not yet support tenant-specific knowledge retrievers',
          },
        });
        return;
      }
      await handleMcpRequest(req, res, mcpServer);
      return;
    }

    // FalkorDB graph API. Like knowledge routes, every operation requires the
    // server API key. Graph access is optional and returns an explicit 503 when
    // the server has no configured FalkorDB connection.
    if (path.startsWith('/api/v1/graph/')) {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }
      if (!graphStore) {
        sendJson(res, 503, {
          error: { code: 'graph_unavailable', message: 'FalkorDB is not configured' },
        });
        return;
      }
      try {
        const handled = await handleGraphRequest(
          req,
          res,
          url,
          path,
          method,
          graphStore,
          tenantId,
          routerConfig.graphOutbox,
          routerConfig.graphCatalogStore,
          incidentStore
        );
        if (handled) return;
      } catch (error) {
        sendJson(res, error instanceof RequestBodyTooLargeError ? 413 : 500, {
          error:
            error instanceof RequestBodyTooLargeError
              ? { code: 'payload_too_large', message: 'Request body exceeds the 1 MiB limit' }
              : { code: 'graph_error', message: 'Graph request failed' },
        });
        return;
      }
    }

    if (
      (path === '/api/v1/incidents' || path.startsWith('/api/v1/incidents/')) &&
      !path.endsWith('/remediations')
    ) {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }
      if (!incidentStore) {
        sendJson(res, 503, {
          error: { code: 'incidents_unavailable', message: 'Incident storage is not configured' },
        });
        return;
      }
      try {
        await handleIncidentRequest(
          req,
          res,
          path,
          method,
          incidentStore,
          actor,
          tenantId,
          graphStore,
          routerConfig.graphCatalogStore
        );
      } catch (error) {
        const invalidTransition =
          error instanceof Error && error.message.startsWith('Invalid incident status transition:');
        sendJson(
          res,
          error instanceof RequestBodyTooLargeError ? 413 : invalidTransition ? 409 : 500,
          {
            error:
              error instanceof RequestBodyTooLargeError
                ? { code: 'payload_too_large', message: 'Request body exceeds the 1 MiB limit' }
                : invalidTransition
                  ? { code: 'invalid_transition', message: error.message }
                  : { code: 'internal_error', message: 'Incident request failed' },
          }
        );
      }
      return;
    }

    if (
      path.startsWith('/api/v1/remediations/') ||
      path.startsWith('/api/v1/evaluations/') ||
      path.endsWith('/remediations')
    ) {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }
      if (!workflowStore) {
        sendJson(res, 503, {
          error: { code: 'workflow_unavailable', message: 'Workflow storage is not configured' },
        });
        return;
      }
      try {
        await handleWorkflowRequest(
          req,
          res,
          url,
          path,
          method,
          incidentStore,
          workflowStore,
          remediation,
          actor,
          tenantId
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const bodyTooLarge = error instanceof RequestBodyTooLargeError;
        const executorUnavailable = message.includes('No controlled remediation executor');
        const conflict =
          message.includes('requires approval') ||
          message.includes('requires separate approval') ||
          message.includes('requires a completed execution') ||
          message.includes('Only pending');
        sendJson(res, bodyTooLarge ? 413 : executorUnavailable ? 503 : conflict ? 409 : 500, {
          error: {
            code: bodyTooLarge
              ? 'payload_too_large'
              : executorUnavailable
                ? 'executor_unavailable'
                : conflict
                  ? 'workflow_conflict'
                  : 'internal_error',
            message: bodyTooLarge
              ? 'Request body exceeds the 1 MiB limit'
              : executorUnavailable
                ? 'No controlled remediation executor is configured'
                : conflict
                  ? 'Workflow state does not allow this action'
                  : 'Workflow request failed',
          },
        });
      }
      return;
    }

    // All other API routes require auth
    if (path.startsWith('/api/v1/knowledge/')) {
      if (!identity) {
        sendJson(res, 401, {
          error: { code: 'unauthorized', message: 'Invalid or missing API key' },
        });
        return;
      }

      if (identity.kind === 'auth0' && !routerConfig.retrieverForTenant) {
        sendJson(res, 503, {
          error: {
            code: 'tenant_retriever_unavailable',
            message: 'Knowledge retrieval is not configured for this Auth0 organization',
          },
        });
        return;
      }

      const start = Date.now();

      try {
        const requestRetriever = routerConfig.retrieverForTenant
          ? await routerConfig.retrieverForTenant(tenantId)
          : retriever;
        if (path === '/api/v1/knowledge/search' && method === 'POST') {
          await handleSearch(req, res, requestRetriever, start);
          return;
        }

        if (path === '/api/v1/knowledge/stats' && method === 'GET') {
          await handleStats(res, requestRetriever, start);
          return;
        }

        if (path === '/api/v1/knowledge/documents' && method === 'GET') {
          await handleDocuments(url, res, requestRetriever, start);
          return;
        }

        if (path === '/api/v1/knowledge/services' && method === 'GET') {
          await handleServices(url, res, requestRetriever, start);
          return;
        }

        if (path === '/api/v1/knowledge/sync' && method === 'POST') {
          await handleSync(res, requestRetriever, start);
          return;
        }

        if (path === '/api/v1/knowledge/sources' && method === 'GET') {
          handleSources(res, config, start);
          return;
        }

        // Document CRUD by ID: /api/v1/knowledge/documents/:id
        if (path.startsWith('/api/v1/knowledge/documents/') && path.split('/').length === 6) {
          const id = decodeURIComponent(path.split('/')[5]);
          await handleDocumentById(req, res, requestRetriever, id, method, start);
          return;
        }
      } catch (error) {
        sendJson(res, error instanceof RequestBodyTooLargeError ? 413 : 500, {
          error: {
            code:
              error instanceof RequestBodyTooLargeError ? 'payload_too_large' : 'internal_error',
            message:
              error instanceof RequestBodyTooLargeError
                ? 'Request body exceeds the 1 MiB limit'
                : 'Knowledge request failed',
          },
          meta: { durationMs: Date.now() - start },
        });
        return;
      }
    }

    // Admin UI — serve static files from admin-dist
    if (path === '/admin' || path.startsWith('/admin/')) {
      await serveAdminFile(path, res);
      return;
    }

    if (
      method === 'GET' &&
      [
        '/',
        '/docs.html',
        '/security.html',
        '/launch.css',
        '/launch.js',
        '/styles.css',
        '/script.js',
      ].includes(path)
    ) {
      await serveLaunchFile(path, res);
      return;
    }

    // Not found
    sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } });
  };
}

type RequestIdentity =
  | { kind: 'api-key' }
  | { kind: 'local-browser' }
  | ({ kind: 'auth0' } & Auth0Identity);

function requestActor(identity: RequestIdentity | undefined): string {
  if (identity?.kind === 'auth0') return `auth0:${identity.sub}`;
  if (identity?.kind === 'local-browser') return 'local-browser';
  return 'api-key';
}

function requiredScopeFor(path: string, method: string): string | undefined {
  if (path === '/mcp') return 'mcp:access';
  if (path === '/api/v1/graph/reconcile' && method === 'POST') return 'graph:admin';
  if (path === '/api/v1/llm/validate') return 'llm:validate';
  if (path === '/api/v1/settings/provider-key') return 'settings:keys';
  if (path.startsWith('/api/v1/graph/')) return method === 'GET' ? 'graph:read' : 'graph:write';
  if (path === '/api/v1/incidents' || path.startsWith('/api/v1/incidents/')) {
    if (path.includes('/remediations')) return 'remediations:propose';
    return method === 'GET' ? 'incidents:read' : 'incidents:write';
  }
  if (path.startsWith('/api/v1/remediations/')) {
    const action = path.split('/').at(-1);
    if (method === 'GET') return 'remediations:read';
    if (action === 'approval' || action === 'rollback-approval') return 'remediations:approve';
    if (action === 'execute') return 'remediations:execute';
    if (action === 'rollback') return 'remediations:rollback';
    if (action === 'reconcile') return 'remediations:reconcile';
  }
  if (path.startsWith('/api/v1/evaluations/')) {
    return method === 'GET' ? 'evaluations:read' : 'evaluations:write';
  }
  if (path.startsWith('/api/v1/knowledge/')) {
    return method === 'GET' ? 'knowledge:read' : 'knowledge:write';
  }
  return undefined;
}

/**
 * A valid Auth0 organization claim proves that Auth0 has admitted the caller
 * to one of this service's configured tenants.  Auth0 does not put API RBAC
 * permissions in a newly-created member's first access token unless a role is
 * assigned separately.  Permit that member to initialize the dashboard's
 * read-only overview while retaining explicit permissions for every mutation,
 * remediation action, settings operation, and model invocation.
 */
const DASHBOARD_BOOTSTRAP_READS = new Set([
  'GET /api/v1/incidents',
  'GET /api/v1/knowledge/stats',
  'GET /api/v1/knowledge/services',
]);

function hasRequiredScope(
  identity: Extract<RequestIdentity, { kind: 'auth0' }>,
  requiredScope: string,
  path: string,
  method: string
): boolean {
  return (
    identity.roles.includes('admin') ||
    identity.scopes.includes(requiredScope) ||
    DASHBOARD_BOOTSTRAP_READS.has(`${method} ${path}`)
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: Error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function resolveRequestIdentity(
  req: IncomingMessage,
  apiKey: string,
  verifyAuth0Token?: (token: string) => Promise<Auth0Identity | undefined>
): Promise<RequestIdentity | undefined> {
  if (authenticateRequest(req, apiKey)) return { kind: 'api-key' };
  if (verifyAuth0Token) {
    const authorization = req.headers.authorization;
    const match =
      typeof authorization === 'string' ? /^Bearer\s+(.+)$/i.exec(authorization) : undefined;
    if (match) {
      const identity = await verifyAuth0Token(match[1]);
      if (identity) return { kind: 'auth0', ...identity };
    }
  }
  return isLocalBrowserRequest(req) ? { kind: 'local-browser' } : undefined;
}

/**
 * Local browser access avoids asking operators to paste the server API key into
 * the UI. It is limited to same-origin browser fetches received over loopback;
 * CLI/remote requests still need an API key or a verified Auth0 token.
 */
export function isLocalBrowserRequest(req: IncomingMessage): boolean {
  const address = (req.socket.remoteAddress || '').replace(/^::ffff:/i, '').toLowerCase();
  if (!['127.0.0.1', '::1'].includes(address)) return false;
  if (req.headers['x-tracemind-local-dashboard'] !== '1') return false;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') return false;

  let requestUrl: URL;
  try {
    requestUrl = new URL(`http://${req.headers.host || ''}`);
  } catch {
    return false;
  }
  const hostname = requestUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '::1'].includes(hostname)) return false;

  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host.toLowerCase() !== requestUrl.host.toLowerCase()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sendProbe(res: ServerResponse, status: number, data: unknown, method: string): void {
  const body = JSON.stringify({ data });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(method === 'HEAD' ? undefined : body);
}

async function handleIncidentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  store: IncidentRepository,
  actor: string,
  tenantId: string,
  graphStore?: FalkorDBStore,
  graphCatalogStore?: Pick<
    PostgresGraphCatalogStore,
    'linkIncidentToService' | 'linkIncidentToServices'
  >
): Promise<void> {
  if (path === '/api/v1/incidents' && method === 'GET') {
    sendJson(res, 200, { data: await store.list(tenantId) });
    return;
  }
  if (path === '/api/v1/incidents' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const title = asNonEmptyString(body.title);
    const severity = body.severity;
    const serviceIds = body.serviceIds === undefined ? [] : body.serviceIds;
    if (
      !title ||
      !isSeverity(severity) ||
      (body.description !== undefined && typeof body.description !== 'string') ||
      (body.assignee !== undefined &&
        body.assignee !== null &&
        typeof body.assignee !== 'string') ||
      !Array.isArray(serviceIds) ||
      serviceIds.length > 50 ||
      serviceIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200)
    ) {
      sendJson(res, 400, {
        error: {
          code: 'bad_request',
          message:
            'title and valid severity are required; description and assignee must be strings; serviceIds must contain up to 50 non-empty strings',
        },
      });
      return;
    }
    const uniqueServiceIds = [...new Set((serviceIds as string[]).map((id) => id.trim()))];
    if (uniqueServiceIds.length && !graphStore && !graphCatalogStore) {
      sendJson(res, 503, {
        error: {
          code: 'graph_unavailable',
          message: 'Cannot link affected services without graph storage',
        },
      });
      return;
    }
    const incident = await store.create(
      {
        title,
        severity,
        description: body.description as string | undefined,
        assignee: body.assignee as string | null | undefined,
      },
      actor,
      tenantId
    );
    if (uniqueServiceIds.length) {
      const linkedServiceIds: string[] = [];
      const link = (serviceId: string) => ({
        orgId: tenantId,
        incidentId: incident.id,
        title: incident.title,
        serviceId,
      });
      try {
        if (graphCatalogStore) {
          // A single PostgreSQL transaction records every link and outbox event,
          // so partial association sets cannot be committed by this route.
          await graphCatalogStore.linkIncidentToServices({
            orgId: tenantId,
            incidentId: incident.id,
            title: incident.title,
            serviceIds: uniqueServiceIds,
          });
          linkedServiceIds.push(...uniqueServiceIds);
        } else {
          for (const serviceId of uniqueServiceIds) {
            await graphStore!.linkIncidentToService(link(serviceId));
            linkedServiceIds.push(serviceId);
          }
        }
      } catch {
        // Incident creation is already committed in its repository. Return its
        // identity and explicit graph-link state so clients can retry links
        // without creating a duplicate incident.
        sendJson(res, 201, {
          data: incident,
          meta: {
            graphProjection: {
              status: linkedServiceIds.length ? 'partial' : 'failed',
              requestedServiceIds: uniqueServiceIds,
              linkedServiceIds,
            },
          },
        });
        return;
      }
      sendJson(res, 201, {
        data: incident,
        meta: {
          provenance: 'Incident service links are tenant-scoped in FalkorDB.',
          graphProjection: {
            status: graphCatalogStore ? 'queued' : 'applied',
            requestedServiceIds: uniqueServiceIds,
            linkedServiceIds,
          },
        },
      });
      return;
    }
    sendJson(res, 201, { data: incident });
    return;
  }
  const match = path.match(/^\/api\/v1\/incidents\/([^/]+)(?:\/(events))?$/);
  if (!match) {
    sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } });
    return;
  }
  const id = decodeURIComponent(match[1]);
  if (match[2] === 'events' && method === 'GET') {
    if (!(await store.get(id, tenantId))) {
      sendJson(res, 404, { error: { code: 'not_found', message: `Incident ${id} not found` } });
      return;
    }
    sendJson(res, 200, { data: await store.events(id, tenantId) });
    return;
  }
  if (!match[2] && method === 'GET') {
    const incident = await store.get(id, tenantId);
    sendJson(
      res,
      incident ? 200 : 404,
      incident
        ? { data: incident }
        : { error: { code: 'not_found', message: `Incident ${id} not found` } }
    );
    return;
  }
  if (!match[2] && method === 'PATCH') {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const patch: Record<string, string | null> = {};
    for (const field of ['title', 'description', 'severity', 'status', 'assignee'] as const) {
      if (body[field] !== undefined) {
        const value = body[field];
        if (field === 'assignee' && value === null) {
          patch[field] = null;
          continue;
        }
        if (
          typeof value !== 'string' ||
          (field === 'title' && !value.trim()) ||
          (field === 'severity' && !isSeverity(value)) ||
          (field === 'status' && !isStatus(value))
        ) {
          sendJson(res, 400, { error: { code: 'bad_request', message: `Invalid ${field}` } });
          return;
        }
        patch[field] = value;
      }
    }
    if (!Object.keys(patch).length) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'At least one supported field is required' },
      });
      return;
    }
    const incident = await store.update(
      id,
      patch as {
        title?: string;
        description?: string;
        severity?: IncidentSeverity;
        status?: IncidentStatus;
        assignee?: string | null;
      },
      actor,
      tenantId
    );
    sendJson(
      res,
      incident ? 200 : 404,
      incident
        ? { data: incident }
        : { error: { code: 'not_found', message: `Incident ${id} not found` } }
    );
    return;
  }
  sendJson(res, 405, { error: { code: 'method_not_allowed', message: `${method} not allowed` } });
}

function isSeverity(value: unknown): value is IncidentSeverity {
  return value === 'SEV-1' || value === 'SEV-2' || value === 'SEV-3' || value === 'SEV-4';
}
function isStatus(value: unknown): value is IncidentStatus {
  return (
    value === 'open' || value === 'investigating' || value === 'mitigated' || value === 'resolved'
  );
}

async function handleGraphRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  method: string,
  graphStore: FalkorDBStore,
  orgId: string,
  graphOutbox?: { enqueue(event: GraphProjectionEvent): Promise<string> },
  graphCatalogStore?: Pick<
    PostgresGraphCatalogStore,
    | 'upsertService'
    | 'linkDependency'
    | 'linkIncidentToService'
    | 'linkIncidentToServices'
    | 'unlinkDependency'
    | 'unlinkIncidentFromService'
    | 'deleteService'
    | 'reconcile'
    | 'checkHealth'
  >,
  incidentStore?: IncidentRepository
): Promise<boolean> {
  if (path === '/api/v1/graph/reconcile' && method === 'POST') {
    if (!graphCatalogStore) {
      sendJson(res, 503, {
        error: { code: 'graph_catalog_unavailable', message: 'Graph catalog is not configured' },
      });
      return true;
    }
    const rebuilt = await graphCatalogStore.reconcile(graphStore, orgId);
    sendJson(res, 200, { data: { organization: orgId, ...rebuilt } });
    return true;
  }

  const serviceDeleteMatch = path.match(/^\/api\/v1\/graph\/services\/([^/]+)$/);
  if (serviceDeleteMatch && method === 'DELETE') {
    const serviceId = decodeURIComponent(serviceDeleteMatch[1]);
    if (graphCatalogStore) {
      const deleted = await graphCatalogStore.deleteService(orgId, serviceId);
      sendJson(
        res,
        deleted ? 202 : 404,
        deleted
          ? { data: { id: serviceId, projection: 'queued' } }
          : { error: { code: 'not_found', message: 'Service not found' } }
      );
    } else {
      await graphStore.deleteService({ orgId, id: serviceId });
      sendJson(res, 200, { data: { id: serviceId, projection: 'applied' } });
    }
    return true;
  }

  const dependencyDeleteMatch = path.match(/^\/api\/v1\/graph\/dependencies\/([^/]+)\/([^/]+)$/);
  if (dependencyDeleteMatch && method === 'DELETE') {
    const dependentId = decodeURIComponent(dependencyDeleteMatch[1]);
    const dependencyId = decodeURIComponent(dependencyDeleteMatch[2]);
    const input = { orgId, dependentId, dependencyId };
    if (graphCatalogStore) {
      const deleted = await graphCatalogStore.unlinkDependency(input);
      sendJson(
        res,
        deleted ? 202 : 404,
        deleted
          ? { data: { dependentId, dependencyId, projection: 'queued' } }
          : { error: { code: 'not_found', message: 'Dependency not found' } }
      );
    } else {
      await graphStore.unlinkDependency(input);
      sendJson(res, 200, { data: { dependentId, dependencyId, projection: 'applied' } });
    }
    return true;
  }

  const incidentServiceDeleteMatch = path.match(
    /^\/api\/v1\/graph\/incidents\/([^/]+)\/services\/([^/]+)$/
  );
  if (incidentServiceDeleteMatch && method === 'DELETE') {
    const incidentId = decodeURIComponent(incidentServiceDeleteMatch[1]);
    const serviceId = decodeURIComponent(incidentServiceDeleteMatch[2]);
    const incident = incidentStore ? await incidentStore.get(incidentId, orgId) : undefined;
    if (incidentStore && !incident) {
      sendJson(res, 404, { error: { code: 'incident_not_found', message: 'Incident not found' } });
      return true;
    }
    const input = { orgId, incidentId, title: incident?.title || incidentId, serviceId };
    if (graphCatalogStore) {
      const deleted = await graphCatalogStore.unlinkIncidentFromService(input);
      sendJson(
        res,
        deleted ? 202 : 404,
        deleted
          ? { data: { incidentId, serviceId, projection: 'queued' } }
          : { error: { code: 'not_found', message: 'Incident-service link not found' } }
      );
    } else {
      await graphStore.unlinkIncidentFromService(input);
      sendJson(res, 200, { data: { incidentId, serviceId, projection: 'applied' } });
    }
    return true;
  }

  const evidencePathMatch = path.match(/^\/api\/v1\/graph\/incidents\/([^/]+)\/evidence-paths$/);
  if (evidencePathMatch && method === 'GET') {
    const rawDepth = url.searchParams.get('depth');
    const depth = rawDepth === null ? 3 : Number(rawDepth);
    if (!Number.isInteger(depth) || depth < 1 || depth > 4) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'depth must be an integer from 1 through 4' },
      });
      return true;
    }
    const data = await graphStore.findIncidentEvidencePaths(
      orgId,
      decodeURIComponent(evidencePathMatch[1]),
      depth
    );
    sendJson(res, 200, { data });
    return true;
  }

  if (path === '/api/v1/graph/services' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const id = asNonEmptyString(body.id);
    const name = asNonEmptyString(body.name);
    if (!id || !name) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'id and name are required strings' },
      });
      return true;
    }
    const service = {
      orgId,
      id,
      name,
      serviceType: asOptionalString(body.serviceType),
      owner: asOptionalString(body.owner),
    };
    if (graphCatalogStore) {
      await graphCatalogStore.upsertService(service);
      sendJson(res, 202, { data: { id, name, projection: 'queued' } });
    } else if (graphOutbox) {
      const eventId = await graphOutbox.enqueue({ type: 'service.upsert', orgId, data: service });
      sendJson(res, 202, { data: { id, name, projection: 'queued', eventId } });
    } else {
      await graphStore.upsertService(service);
      sendJson(res, 201, { data: { id, name } });
    }
    return true;
  }

  if (path === '/api/v1/graph/dependencies' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const dependentId = asNonEmptyString(body.dependentId);
    const dependencyId = asNonEmptyString(body.dependencyId);
    if (!dependentId || !dependencyId || dependentId === dependencyId) {
      sendJson(res, 400, {
        error: {
          code: 'bad_request',
          message: 'dependentId and a different dependencyId are required',
        },
      });
      return true;
    }
    const criticality = body.criticality as 'critical' | 'degraded' | 'optional' | undefined;
    if (
      criticality !== undefined &&
      criticality !== 'critical' &&
      criticality !== 'degraded' &&
      criticality !== 'optional'
    ) {
      sendJson(res, 400, {
        error: {
          code: 'bad_request',
          message: 'criticality must be critical, degraded, or optional',
        },
      });
      return true;
    }
    const dependency = { orgId, dependentId, dependencyId, criticality };
    if (graphCatalogStore) {
      await graphCatalogStore.linkDependency(dependency);
      sendJson(res, 202, {
        data: {
          dependentId,
          dependencyId,
          criticality: criticality || 'degraded',
          projection: 'queued',
        },
      });
    } else if (graphOutbox) {
      const eventId = await graphOutbox.enqueue({
        type: 'dependency.link',
        orgId,
        data: dependency,
      });
      sendJson(res, 202, {
        data: {
          dependentId,
          dependencyId,
          criticality: criticality || 'degraded',
          projection: 'queued',
          eventId,
        },
      });
    } else {
      await graphStore.linkDependency(dependency);
      sendJson(res, 201, {
        data: { dependentId, dependencyId, criticality: criticality || 'degraded' },
      });
    }
    return true;
  }

  const serviceMatch = path.match(/^\/api\/v1\/graph\/services\/([^/]+)\/neighborhood$/);
  if (serviceMatch && method === 'GET') {
    const serviceId = decodeURIComponent(serviceMatch[1]);
    const data = await graphStore.getServiceNeighborhood(orgId, serviceId);
    sendJson(res, 200, { data });
    return true;
  }

  const incidentMatch = path.match(/^\/api\/v1\/graph\/incidents\/([^/]+)\/services$/);
  if (incidentMatch && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const title = asNonEmptyString(body.title);
    const serviceId = asNonEmptyString(body.serviceId);
    if (!title || !serviceId) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'title and serviceId are required strings' },
      });
      return true;
    }
    const incidentId = decodeURIComponent(incidentMatch[1]);
    if (incidentStore && !(await incidentStore.get(incidentId, orgId))) {
      sendJson(res, 404, { error: { code: 'incident_not_found', message: 'Incident not found' } });
      return true;
    }
    if (graphCatalogStore) {
      await graphCatalogStore.linkIncidentToService({ orgId, incidentId, title, serviceId });
      sendJson(res, 202, { data: { incidentId, serviceId, projection: 'queued' } });
    } else {
      await graphStore.linkIncidentToService({ orgId, incidentId, title, serviceId });
      sendJson(res, 201, { data: { incidentId, serviceId } });
    }
    return true;
  }

  const relatedMatch = path.match(/^\/api\/v1\/graph\/incidents\/([^/]+)\/related$/);
  if (relatedMatch && method === 'GET') {
    const incidentId = decodeURIComponent(relatedMatch[1]);
    const data = await graphStore.findRelatedIncidents(orgId, incidentId);
    sendJson(res, 200, { data });
    return true;
  }

  return false;
}

async function handleWorkflowRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  method: string,
  incidentStore: IncidentRepository | undefined,
  store: WorkflowRepository,
  remediation: RemediationWorkflow,
  actor: string,
  tenantId: string
): Promise<void> {
  if (path === '/api/v1/evaluations/cases' && method === 'POST') {
    const body = await readJsonBody(req, res);
    if (!body) return;
    const input = parseEvaluationCase(body);
    if (!input) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'Invalid evaluation case payload' },
      });
      return;
    }
    const score = await store.recordEvaluation(input, tenantId);
    sendJson(res, 201, {
      data: {
        dataset: input.dataset,
        caseId: input.caseId,
        score,
      },
      meta: { provenance: 'caller_submitted_unverified' },
    });
    return;
  }
  if (path === '/api/v1/evaluations/analytics' && method === 'GET') {
    const dataset = url.searchParams.get('dataset')?.trim();
    if (!dataset) {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'dataset is required' } });
      return;
    }
    sendJson(res, 200, {
      data: await store.getEvaluationAnalytics(dataset, tenantId),
      meta: { provenance: 'caller_submitted_unverified' },
    });
    return;
  }
  if (path === '/api/v1/evaluations/cases' && method === 'GET') {
    const dataset = url.searchParams.get('dataset')?.trim();
    if (!dataset) {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'dataset is required' } });
      return;
    }
    sendJson(res, 200, {
      data: await store.listEvaluations(dataset, tenantId),
      meta: { provenance: 'caller_submitted_unverified' },
    });
    return;
  }
  const createMatch = path.match(/^\/api\/v1\/incidents\/([^/]+)\/remediations$/);
  if (createMatch && method === 'POST') {
    if (!incidentStore) {
      sendJson(res, 503, {
        error: { code: 'incidents_unavailable', message: 'Incident storage is not configured' },
      });
      return;
    }
    const incidentId = decodeURIComponent(createMatch[1]);
    if (!(await incidentStore.get(incidentId, tenantId))) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Incident not found' } });
      return;
    }
    const body = await readJsonBody(req, res);
    if (!body) return;
    const title = asNonEmptyString(body.title);
    const steps = parseRemediationSteps(body.steps);
    if (!title || !steps) {
      sendJson(res, 400, {
        error: {
          code: 'bad_request',
          message: 'title and actionId/postCheckId/rollbackActionId/description steps are required',
        },
      });
      return;
    }
    sendJson(res, 201, { data: await store.createPlan(incidentId, title, steps, actor, tenantId) });
    return;
  }
  const planMatch = path.match(
    /^\/api\/v1\/remediations\/([^/]+)(?:\/steps\/([^/]+)\/(approval|execute|rollback-approval|rollback|reconcile))?$/
  );
  if (!planMatch) {
    sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } });
    return;
  }
  const planId = decodeURIComponent(planMatch[1]);
  const stepId = planMatch[2] ? decodeURIComponent(planMatch[2]) : undefined;
  const action = planMatch[3];
  if (!action && method === 'GET') {
    const plan = await store.getPlan(planId, tenantId);
    if (!plan) {
      sendJson(res, 404, { error: { code: 'not_found', message: 'Remediation plan not found' } });
      return;
    }
    sendJson(res, 200, { data: { ...plan, events: await store.events(planId, tenantId) } });
    return;
  }
  if (!stepId || method !== 'POST') {
    sendJson(res, 405, { error: { code: 'method_not_allowed', message: `${method} not allowed` } });
    return;
  }
  if (action === 'reconcile') {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (
      (body.operation !== 'execute' &&
        body.operation !== 'verify' &&
        body.operation !== 'rollback') ||
      typeof body.succeeded !== 'boolean' ||
      !asNonEmptyString(body.evidence)
    ) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'operation, succeeded, and evidence are required' },
      });
      return;
    }
    const updated = await store.resolveUnknown(
      planId,
      stepId,
      body.operation,
      body.succeeded,
      body.evidence as string,
      actor,
      tenantId
    );
    if (!updated) {
      sendJson(res, 409, {
        error: {
          code: 'workflow_conflict',
          message: 'No matching unknown outcome is available to reconcile',
        },
      });
      return;
    }
    const reconciledPlan = await store.getPlan(planId, tenantId);
    sendJson(res, 200, {
      data: reconciledPlan
        ? { ...reconciledPlan, events: await store.events(planId, tenantId) }
        : undefined,
    });
    return;
  }
  if (action === 'execute') {
    const result = await remediation.execute(planId, stepId, actor, tenantId);
    sendJson(
      res,
      result.executionSucceeded && result.verificationSucceeded
        ? 200
        : result.executionSucceeded
          ? 409
          : 502,
      { data: result }
    );
    return;
  }
  if (action === 'rollback') {
    const result = await remediation.rollback(planId, stepId, actor, tenantId);
    sendJson(res, result.status === 'rolled_back' ? 200 : 502, { data: result });
    return;
  }
  if (action === 'approval' || action === 'rollback-approval') {
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (
      (body.decision !== 'approve' && body.decision !== 'reject') ||
      !asNonEmptyString(body.reason)
    ) {
      sendJson(res, 400, {
        error: { code: 'bad_request', message: 'decision and reason are required' },
      });
      return;
    }
    const plan = await (action === 'approval'
      ? store.decide(planId, stepId, body.decision, actor, body.reason as string, tenantId)
      : store.decideRollback(
          planId,
          stepId,
          body.decision,
          actor,
          body.reason as string,
          tenantId
        ));
    if (!plan) {
      sendJson(res, 404, {
        error: { code: 'not_found', message: 'Remediation plan or step not found' },
      });
      return;
    }
    sendJson(res, 200, { data: plan });
    return;
  }
  sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${method} ${path}` } });
}

function parseRemediationSteps(value: unknown): RemediationStepInput[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return null;
  const steps: RemediationStepInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const step = item as Record<string, unknown>;
    const actionId = asNonEmptyString(step.actionId);
    const postCheckId = asNonEmptyString(step.postCheckId);
    const rollbackActionId = asNonEmptyString(step.rollbackActionId);
    const description = asNonEmptyString(step.description);
    if (
      !actionId ||
      !postCheckId ||
      !rollbackActionId ||
      !description ||
      [actionId, postCheckId, rollbackActionId].some((x) => x.length > 160) ||
      description.length > 1000
    )
      return null;
    steps.push({ actionId, postCheckId, rollbackActionId, description });
  }
  return steps;
}

function parseEvaluationCase(body: Record<string, unknown>): EvaluationCaseInput | null {
  const variant = (value: unknown): EvaluationCaseInput['baseline'] | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (
      typeof item.rootCause !== 'string' ||
      !Array.isArray(item.evidenceIds) ||
      !item.evidenceIds.every((x) => typeof x === 'string') ||
      !['succeeded', 'failed', 'not_run'].includes(String(item.fixOutcome))
    )
      return null;
    return {
      rootCause: item.rootCause,
      evidenceIds: item.evidenceIds as string[],
      fixOutcome: item.fixOutcome as 'succeeded' | 'failed' | 'not_run',
    };
  };
  const baseline = variant(body.baseline);
  const graph = variant(body.graph);
  if (
    typeof body.dataset !== 'string' ||
    !body.dataset.trim() ||
    body.dataset.length > 120 ||
    typeof body.caseId !== 'string' ||
    !body.caseId.trim() ||
    body.caseId.length > 160 ||
    typeof body.groundTruthRootCause !== 'string' ||
    !body.groundTruthRootCause.trim() ||
    body.groundTruthRootCause.length > 1000 ||
    !Array.isArray(body.relevantEvidenceIds) ||
    body.relevantEvidenceIds.length > 500 ||
    !body.relevantEvidenceIds.every((x) => typeof x === 'string') ||
    !['succeeded', 'failed'].includes(String(body.expectedFixOutcome)) ||
    !baseline ||
    !graph
  )
    return null;
  if (
    [...body.relevantEvidenceIds, ...baseline.evidenceIds, ...graph.evidenceIds].length > 1500 ||
    [...body.relevantEvidenceIds, ...baseline.evidenceIds, ...graph.evidenceIds].some(
      (id) => id.length > 200
    ) ||
    baseline.evidenceIds.length > 500 ||
    graph.evidenceIds.length > 500 ||
    baseline.rootCause.length > 1000 ||
    graph.rootCause.length > 1000
  )
    return null;
  return {
    dataset: body.dataset.trim(),
    caseId: body.caseId.trim(),
    groundTruthRootCause: body.groundTruthRootCause.trim(),
    relevantEvidenceIds: body.relevantEvidenceIds as string[],
    expectedFixOutcome: body.expectedFixOutcome as 'succeeded' | 'failed',
    baseline,
    graph,
  };
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (error) {
    if (!(error instanceof RequestBodyTooLargeError)) throw error;
    sendJson(res, 413, {
      error: { code: 'payload_too_large', message: 'Request body exceeds the 1 MiB limit' },
    });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Report a stable client error below.
  }
  sendJson(res, 400, { error: { code: 'bad_request', message: 'Expected a JSON object body' } });
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function handleSearch(
  req: IncomingMessage,
  res: ServerResponse,
  retriever: IKnowledgeRetriever,
  start: number
): Promise<void> {
  const body = await readBody(req);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } });
    return;
  }

  const query = String(parsed.query || '');
  if (!query.trim()) {
    sendJson(res, 400, { error: { code: 'bad_request', message: 'query is required' } });
    return;
  }

  const options: {
    typeFilter?: KnowledgeType[];
    serviceFilter?: string[];
    limit?: number;
    rerank?: boolean;
  } = {};

  if (Array.isArray(parsed.typeFilter)) {
    options.typeFilter = parsed.typeFilter.map(String) as KnowledgeType[];
  }
  if (Array.isArray(parsed.serviceFilter)) {
    options.serviceFilter = parsed.serviceFilter.map(String);
  }
  if (typeof parsed.limit === 'number') {
    options.limit = parsed.limit;
  }
  if (typeof parsed.rerank === 'boolean') {
    options.rerank = parsed.rerank;
  }

  const results = await retriever.search(query, options);
  sendJson(res, 200, { data: results, meta: { durationMs: Date.now() - start } });
}

async function handleStats(
  res: ServerResponse,
  retriever: IKnowledgeRetriever,
  start: number
): Promise<void> {
  const counts = await retriever.getDocumentCountsByType();
  sendJson(res, 200, { data: counts, meta: { durationMs: Date.now() - start } });
}

async function handleDocuments(
  url: URL,
  res: ServerResponse,
  retriever: IKnowledgeRetriever,
  start: number
): Promise<void> {
  let docs = await retriever.getAllDocuments();
  const typeFilter = url.searchParams.get('type');
  if (typeFilter) {
    docs = docs.filter((d) => d.type === typeFilter);
  }
  sendJson(res, 200, { data: docs, meta: { durationMs: Date.now() - start } });
}

async function handleServices(
  url: URL,
  res: ServerResponse,
  retriever: IKnowledgeRetriever,
  start: number
): Promise<void> {
  const allDocs = await retriever.getAllDocuments();
  const typeFilter = url.searchParams.get('type') as KnowledgeType | null;
  const services = new Set<string>();

  for (const doc of allDocs) {
    if (typeFilter && doc.type !== typeFilter) continue;
    for (const service of doc.services) {
      services.add(service);
    }
  }

  sendJson(res, 200, {
    data: Array.from(services).sort(),
    meta: { durationMs: Date.now() - start },
  });
}

async function handleSync(
  res: ServerResponse,
  retriever: IKnowledgeRetriever,
  start: number
): Promise<void> {
  const result = await retriever.sync();
  sendJson(res, 200, { data: result, meta: { durationMs: Date.now() - start } });
}

async function handleDocumentById(
  req: IncomingMessage,
  res: ServerResponse,
  retriever: IKnowledgeRetriever,
  id: string,
  method: string,
  start: number
): Promise<void> {
  if (method === 'GET') {
    if (!retriever.getDocument) {
      sendJson(res, 501, {
        error: { code: 'not_implemented', message: 'getDocument not supported' },
      });
      return;
    }
    const doc = await retriever.getDocument(id);
    if (!doc) {
      sendJson(res, 404, { error: { code: 'not_found', message: `Document ${id} not found` } });
      return;
    }
    sendJson(res, 200, { data: doc, meta: { durationMs: Date.now() - start } });
    return;
  }

  if (method === 'PUT') {
    if (!retriever.getDocument || !retriever.upsertDocument) {
      sendJson(res, 501, {
        error: { code: 'not_implemented', message: 'upsertDocument not supported' },
      });
      return;
    }
    const body = await readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid JSON body' } });
      return;
    }

    const existing = await retriever.getDocument(id);
    if (!existing) {
      sendJson(res, 404, { error: { code: 'not_found', message: `Document ${id} not found` } });
      return;
    }

    const updated: KnowledgeDocument = {
      ...existing,
      title: typeof parsed.title === 'string' ? parsed.title : existing.title,
      content: typeof parsed.content === 'string' ? parsed.content : existing.content,
      type: typeof parsed.type === 'string' ? (parsed.type as KnowledgeType) : existing.type,
      services: Array.isArray(parsed.services) ? parsed.services.map(String) : existing.services,
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : existing.tags,
      updatedAt: new Date().toISOString(),
    };

    await retriever.upsertDocument(updated);
    sendJson(res, 200, { data: updated, meta: { durationMs: Date.now() - start } });
    return;
  }

  if (method === 'DELETE') {
    if (!retriever.deleteDocument) {
      sendJson(res, 501, {
        error: { code: 'not_implemented', message: 'deleteDocument not supported' },
      });
      return;
    }
    await retriever.deleteDocument(id);
    sendJson(res, 200, { data: { deleted: true }, meta: { durationMs: Date.now() - start } });
    return;
  }

  sendJson(res, 405, { error: { code: 'method_not_allowed', message: `${method} not allowed` } });
}

function handleSources(res: ServerResponse, config: Config, start: number): void {
  const sources = (config.knowledge?.sources || []).map((s) => ({
    type: s.type,
    path: s.path,
    repo: s.repo,
    branch: s.branch,
    baseUrl: s.baseUrl,
    spaceKey: s.spaceKey,
    endpoint: s.endpoint,
    databaseId: s.databaseId,
    authConfigured: !!s.auth,
  }));
  sendJson(res, 200, { data: sources, meta: { durationMs: Date.now() - start } });
}
