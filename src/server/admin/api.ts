export interface HealthData {
  status: string;
  version: string;
  uptime: number;
  database?: 'postgres' | 'sqlite' | 'unknown';
  components?: Record<string, string>;
}

export interface ProviderKeyStatus {
  configured: boolean;
  provider?: string;
  updatedAt?: string;
}

export interface LLMValidationResult {
  status: 'connected';
  provider: string;
  model: string;
  response: string;
  checkedAt: string;
  usedFallback?: boolean;
  credentialSource?: 'primary' | 'fallback';
  primaryFailure?: {
    category: string;
    status?: number;
  };
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  severity: 'SEV-1' | 'SEV-2' | 'SEV-3' | 'SEV-4';
  status: 'open' | 'investigating' | 'mitigated' | 'resolved';
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface IncidentEvent {
  id: number;
  incidentId: string;
  action: string;
  detail: string;
  actor: string;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: string;
  type: string;
  title: string;
  content: string;
  services: string[];
  tags: string[];
  chunks: unknown[];
  createdAt: string;
  updatedAt: string;
  author?: string;
  sourceUrl?: string;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  title: string;
  content: string;
  type: string;
  services: string[];
  score: number;
  sourceUrl?: string;
}

export interface RetrievedKnowledge {
  runbooks: RetrievedChunk[];
  postmortems: RetrievedChunk[];
  architecture: RetrievedChunk[];
  knownIssues: RetrievedChunk[];
}

export interface SourceInfo {
  type: string;
  path?: string;
  repo?: string;
  branch?: string;
  baseUrl?: string;
  spaceKey?: string;
  endpoint?: string;
  databaseId?: string;
  authConfigured: boolean;
}

export interface EvidencePath {
  rootIncidentId: string;
  rootIncidentTitle: string;
  incidentId: string;
  incidentTitle: string;
  services: Array<{ id: string; name: string }>;
  edges: Array<{ from: string; to: string; relationship: string; criticality?: string }>;
  rationale: string;
}

export interface RemediationStep {
  id: string;
  actionId: string;
  postCheckId: string;
  rollbackActionId: string;
  description: string;
  status: string;
  rollbackApproved: boolean;
  executionResult?: { succeeded: boolean; output?: string; error?: string };
  verificationResult?: { succeeded: boolean; evidence?: string; error?: string };
  rollbackResult?: { succeeded: boolean; output?: string; error?: string };
}

export interface RemediationPlan {
  id: string;
  incidentId: string;
  title: string;
  createdAt: string;
  createdBy: string;
  steps: RemediationStep[];
  events: Array<{ id: number; action: string; actor: string; detail: string; createdAt: string }>;
}

export interface EvaluationAnalytics {
  dataset: string;
  cases: number;
  baseline: Record<
    | 'rootCauseAccuracy'
    | 'evidencePrecision'
    | 'evidenceRecall'
    | 'retrievalQuality'
    | 'fixOutcomeAccuracy',
    number
  >;
  graph: Record<
    | 'rootCauseAccuracy'
    | 'evidencePrecision'
    | 'evidenceRecall'
    | 'retrievalQuality'
    | 'fixOutcomeAccuracy',
    number
  >;
}

export class AdminApi {
  constructor(private credential?: string | ((scope?: string) => Promise<string>)) {}

  private unexpectedResponse(path: string, res: Response, contentType: string): Error {
    const status = `HTTP ${res.status}`;
    const type = contentType || 'unknown content type';
    const redirectHint = res.redirected
      ? ' The request was redirected, which can happen when the API route is unavailable or the session is no longer valid.'
      : '';
    return new Error(
      `TraceMind API ${path} returned a non-JSON response (${status}, ${type}). Check that the deployed API route is available and sign in again if needed.${redirectHint}`
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token =
      typeof this.credential === 'string'
        ? this.credential
        : typeof this.credential === 'function'
          ? await this.credential(path === '/api/v1/llm/validate' ? 'llm:validate' : undefined)
          : undefined;
    const res = await fetch(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(!token ? { 'X-TraceMind-Local-Dashboard': '1' } : {}),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const contentType =
      res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!contentType.includes('json')) {
      // Render/static-host fallbacks and Auth0 redirects can return an HTML
      // document for an API request. Calling res.json() here masks the useful
      // HTTP status with an opaque "Unexpected token '<'" SyntaxError.
      throw this.unexpectedResponse(path, res, contentType);
    }

    let json: { data?: T; error?: { message?: string } };
    try {
      json = (await res.json()) as { data?: T; error?: { message?: string } };
    } catch {
      throw this.unexpectedResponse(path, res, contentType);
    }
    if (!res.ok) {
      throw new Error(json.error?.message || `Request failed: ${res.status}`);
    }
    return json.data as T;
  }

  getHealth(): Promise<HealthData> {
    return this.request('GET', '/api/v1/health');
  }

  validateApiKey(): Promise<{ authenticated: boolean }> {
    return this.request('GET', '/api/v1/auth/validate');
  }

  getProviderKeyStatus(): Promise<ProviderKeyStatus> {
    return this.request('GET', '/api/v1/settings/provider-key');
  }

  saveProviderKey(provider: string, apiKey: string): Promise<ProviderKeyStatus> {
    return this.request('PUT', '/api/v1/settings/provider-key', { provider, apiKey });
  }

  deleteProviderKey(): Promise<{ deleted: boolean }> {
    return this.request('DELETE', '/api/v1/settings/provider-key');
  }

  validateLLM(
    credentialSource: 'auto' | 'primary' | 'fallback' = 'auto'
  ): Promise<LLMValidationResult> {
    return this.request('POST', '/api/v1/llm/validate', { credentialSource });
  }

  getStats(): Promise<Record<string, number>> {
    return this.request('GET', '/api/v1/knowledge/stats');
  }

  getDocuments(type?: string): Promise<KnowledgeDocument[]> {
    const params = type ? `?type=${encodeURIComponent(type)}` : '';
    return this.request('GET', `/api/v1/knowledge/documents${params}`);
  }

  getDocument(id: string): Promise<KnowledgeDocument> {
    return this.request('GET', `/api/v1/knowledge/documents/${encodeURIComponent(id)}`);
  }

  updateDocument(id: string, doc: Partial<KnowledgeDocument>): Promise<KnowledgeDocument> {
    return this.request('PUT', `/api/v1/knowledge/documents/${encodeURIComponent(id)}`, doc);
  }

  deleteDocument(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/api/v1/knowledge/documents/${encodeURIComponent(id)}`);
  }

  search(
    query: string,
    options?: { typeFilter?: string[]; serviceFilter?: string[] }
  ): Promise<RetrievedKnowledge> {
    return this.request('POST', '/api/v1/knowledge/search', { query, ...options });
  }

  getServices(type?: string): Promise<string[]> {
    const params = type ? `?type=${encodeURIComponent(type)}` : '';
    return this.request('GET', `/api/v1/knowledge/services${params}`);
  }

  getSources(): Promise<SourceInfo[]> {
    return this.request('GET', '/api/v1/knowledge/sources');
  }

  sync(): Promise<{ added: number; updated: number }> {
    return this.request('POST', '/api/v1/knowledge/sync');
  }

  getIncidents(): Promise<Incident[]> {
    return this.request('GET', '/api/v1/incidents');
  }
  createIncident(
    input: Pick<Incident, 'title' | 'severity'> &
      Partial<Pick<Incident, 'description' | 'assignee'>>
  ): Promise<Incident> {
    return this.request('POST', '/api/v1/incidents', input);
  }
  updateIncident(
    id: string,
    patch: Partial<Pick<Incident, 'title' | 'description' | 'severity' | 'status' | 'assignee'>>
  ): Promise<Incident> {
    return this.request('PATCH', `/api/v1/incidents/${encodeURIComponent(id)}`, patch);
  }
  getIncidentEvents(id: string): Promise<IncidentEvent[]> {
    return this.request('GET', `/api/v1/incidents/${encodeURIComponent(id)}/events`);
  }

  getEvidencePaths(incidentId: string, depth = 3): Promise<EvidencePath[]> {
    return this.request(
      'GET',
      `/api/v1/graph/incidents/${encodeURIComponent(incidentId)}/evidence-paths?depth=${depth}`
    );
  }
  getRelatedIncidents(
    incidentId: string
  ): Promise<Array<{ id: string; title: string; sharedServices: string[] }>> {
    return this.request('GET', `/api/v1/graph/incidents/${encodeURIComponent(incidentId)}/related`);
  }
  createRemediation(
    incidentId: string,
    title: string,
    steps: Array<
      Pick<RemediationStep, 'actionId' | 'postCheckId' | 'rollbackActionId' | 'description'>
    >
  ): Promise<RemediationPlan> {
    return this.request(
      'POST',
      `/api/v1/incidents/${encodeURIComponent(incidentId)}/remediations`,
      { title, steps }
    );
  }
  getRemediation(planId: string): Promise<RemediationPlan> {
    return this.request('GET', `/api/v1/remediations/${encodeURIComponent(planId)}`);
  }
  remediationDecision(
    planId: string,
    stepId: string,
    decision: 'approve' | 'reject',
    reason: string,
    rollback = false
  ): Promise<RemediationPlan> {
    const action = rollback ? 'rollback-approval' : 'approval';
    return this.request(
      'POST',
      `/api/v1/remediations/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/${action}`,
      { decision, reason }
    );
  }
  executeRemediation(planId: string, stepId: string): Promise<unknown> {
    return this.request(
      'POST',
      `/api/v1/remediations/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/execute`
    );
  }
  rollbackRemediation(planId: string, stepId: string): Promise<unknown> {
    return this.request(
      'POST',
      `/api/v1/remediations/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/rollback`
    );
  }
  getEvaluationAnalytics(dataset: string): Promise<EvaluationAnalytics> {
    return this.request(
      'GET',
      `/api/v1/evaluations/analytics?dataset=${encodeURIComponent(dataset)}`
    );
  }
  getEvaluationCases(dataset: string): Promise<
    Array<{
      caseId: string;
      recordedAt: string;
      score: {
        baseline: Record<string, number | boolean>;
        graph: Record<string, number | boolean>;
      };
    }>
  > {
    return this.request('GET', `/api/v1/evaluations/cases?dataset=${encodeURIComponent(dataset)}`);
  }
}
