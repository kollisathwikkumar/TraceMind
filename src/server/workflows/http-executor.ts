import type { RemediationExecutor } from './remediation';

export interface ExecutorContext {
  incidentId: string;
  planId: string;
  stepId: string;
  idempotencyKey: string;
}
export type ExecutorFetch = (input: URL, init?: RequestInit) => Promise<Response>;
export interface ExecutorRegistry {
  actionIds: readonly string[];
  checkIds: readonly string[];
  rollbackActionIds: readonly string[];
  /** Exact origins authorized to receive the broker token. Wildcards are not supported. */
  allowedOrigins: readonly string[];
}

/** Calls a separately deployed, authenticated action broker over HTTPS. */
export class HttpRemediationExecutor implements RemediationExecutor {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: ExecutorFetch = fetch,
    private readonly timeoutMs = 15_000,
    private readonly registry: ExecutorRegistry
  ) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.search || this.baseUrl.hash) {
      throw new Error('Remediation executor URL must not include credentials, query, or fragment');
    }
    if (this.baseUrl.protocol !== 'https:' && !isLoopback(this.baseUrl.hostname)) {
      throw new Error('Remediation executor URL must use HTTPS');
    }
    if (!registry.allowedOrigins.includes(this.baseUrl.origin)) {
      throw new Error('Remediation executor origin is not in the configured origin allowlist');
    }
    if (!token.trim()) throw new Error('Remediation executor token is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error('Remediation executor timeout must be 1..120000 ms');
    }
  }

  execute(actionId: string, context: ExecutorContext) {
    this.assertRegistered(this.registry?.actionIds, actionId);
    return this.call('/actions/execute', actionId, context, 'action');
  }

  verify(checkId: string, context: ExecutorContext) {
    this.assertRegistered(this.registry?.checkIds, checkId);
    return this.call('/checks/verify', checkId, context, 'check');
  }

  rollback(actionId: string, context: ExecutorContext) {
    this.assertRegistered(this.registry?.rollbackActionIds, actionId);
    return this.call('/actions/rollback', actionId, context, 'action');
  }

  private async call(
    route: string,
    identifier: string,
    context: ExecutorContext,
    resultType: 'action' | 'check'
  ): Promise<{ succeeded: boolean; output?: string; evidence?: string; error?: string }> {
    if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(identifier)) {
      throw new Error('Executor identifiers must use the registered ID format');
    }
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(context.idempotencyKey)) {
      throw new Error('Executor idempotency key must use the registered key format');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const url = new URL(route.replace(/^\//, ''), ensureSlash(this.baseUrl));
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': context.idempotencyKey,
        },
        // Never follow a broker redirect: redirects can exfiltrate the bearer token.
        redirect: 'error',
        body: JSON.stringify({ identifier, incidentId: context.incidentId, planId: context.planId, stepId: context.stepId }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Controlled executor responded with HTTP ${response.status}`);
      const payload: unknown = await response.json();
      if (!isExecutorResult(payload, resultType)) {
        throw new Error('Controlled executor returned an invalid result');
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  private assertRegistered(registry: readonly string[] | undefined, identifier: string): void {
    if (!registry?.includes(identifier)) {
      throw new Error('Executor identifier is not registered in the server allowlist');
    }
  }
}

function isExecutorResult(
  value: unknown,
  resultType: 'action' | 'check'
): value is { succeeded: boolean; output?: string; evidence?: string; error?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (typeof result.succeeded !== 'boolean') return false;
  if (result.output !== undefined && typeof result.output !== 'string') return false;
  if (result.evidence !== undefined && typeof result.evidence !== 'string') return false;
  if (result.error !== undefined && typeof result.error !== 'string') return false;
  if (resultType === 'action' && result.evidence !== undefined) return false;
  if (resultType === 'check' && result.output !== undefined) return false;
  return true;
}

function ensureSlash(url: URL): URL {
  return new URL(url.pathname.endsWith('/') ? url.href : `${url.href}/`);
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function createConfiguredRemediationExecutor(
  environment: NodeJS.ProcessEnv = process.env
): HttpRemediationExecutor | undefined {
  const endpoint = environment.TRACEMIND_REMEDIATION_EXECUTOR_URL?.trim();
  const token = environment.TRACEMIND_REMEDIATION_EXECUTOR_TOKEN?.trim();
  if (!endpoint && !token) return undefined;
  if (!endpoint || !token) {
    throw new Error(
      'TRACEMIND_REMEDIATION_EXECUTOR_URL and TRACEMIND_REMEDIATION_EXECUTOR_TOKEN must be configured together'
    );
  }
  const actionIds = parseAllowlist(environment.TRACEMIND_REMEDIATION_ACTION_IDS, 'ACTION_IDS');
  const checkIds = parseAllowlist(environment.TRACEMIND_REMEDIATION_CHECK_IDS, 'CHECK_IDS');
  const rollbackActionIds = parseAllowlist(environment.TRACEMIND_REMEDIATION_ROLLBACK_IDS, 'ROLLBACK_IDS');
  const allowedOrigins = parseAllowedOrigins(
    environment.TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS
  );
  if (!actionIds.length || !checkIds.length || !rollbackActionIds.length) {
    throw new Error(
      'Configure action, check, and rollback ID allowlists before enabling remediation execution'
    );
  }
  return new HttpRemediationExecutor(endpoint, token, fetch, 15_000, {
    actionIds,
    checkIds,
    rollbackActionIds,
    allowedOrigins,
  });
}

/** Production can opt into fail-closed startup when no broker is configured. */
export function isRemediationExecutorRequired(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const value = environment.TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED must be true or false');
}

/** Resolve deployment policy and fail early when required execution is absent. */
export function resolveRemediationExecutor(
  override: RemediationExecutor | undefined,
  environment: NodeJS.ProcessEnv = process.env
): { executor: RemediationExecutor | undefined; required: boolean } {
  const executor = override ?? createConfiguredRemediationExecutor(environment);
  const required = isRemediationExecutorRequired(environment);
  if (required && !executor) {
    throw new Error(
      'TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED is true but no remediation executor is configured'
    );
  }
  return { executor, required };
}

function parseAllowlist(value: string | undefined, name: string): string[] {
  const entries = (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.some((entry) => !/^[a-zA-Z0-9._:-]{1,160}$/.test(entry))) {
    throw new Error(`TRACEMIND_REMEDIATION_${name} contains an invalid identifier`);
  }
  return [...new Set(entries)];
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const entries = (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) {
    throw new Error('Configure TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS before enabling remediation execution');
  }
  const origins = entries.map((entry) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new Error('TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS contains an invalid origin');
    }
    if (
      parsed.origin !== entry ||
      (parsed.protocol !== 'https:' && !isLoopback(parsed.hostname)) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS must contain exact HTTPS origins');
    }
    return parsed.origin;
  });
  return [...new Set(origins)];
}
