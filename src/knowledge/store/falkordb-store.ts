/**
 * FalkorDB projection for incident/service relationships.
 * PostgreSQL remains the future system of record; this adapter owns only graph
 * projections and graph-assisted retrieval.
 */

import { FalkorDB } from 'falkordb';

export interface GraphRow {
  [key: string]: unknown;
}

/** Maximum server-side runtime for the variable-depth incident evidence query. */
export const GRAPH_EVIDENCE_QUERY_TIMEOUT_MS = 5_000;

export interface FalkorGraphPort {
  query<T = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ headers?: string[]; data?: T[] }>;
  roQuery<T = unknown>(
    query: string,
    options?: { params?: Record<string, unknown>; TIMEOUT?: number }
  ): Promise<{ headers?: string[]; data?: T[] }>;
}

export interface FalkorDBConnection {
  store: FalkorDBStore;
  close(): Promise<void>;
}

export interface ServiceNeighborhoodItem {
  id: string;
  name: string;
  relationship: string;
  direction: 'upstream' | 'downstream';
}

export interface RelatedIncident {
  id: string;
  title: string;
  sharedServices: string[];
}

export interface IncidentEvidencePath {
  rootIncidentId: string;
  rootIncidentTitle: string;
  incidentId: string;
  incidentTitle: string;
  services: Array<{ id: string; name: string }>;
  edges: Array<{ from: string; to: string; relationship: string; criticality?: string }>;
  rationale: string;
}

/**
 * FalkorDB-backed graph projection. Every operation is parameterized and
 * organization-scoped. MERGE makes event replay idempotent.
 */
export class FalkorDBStore {
  constructor(private readonly graph: FalkorGraphPort) {}

  /**
   * Create the range indexes used by tenant-scoped graph lookups before serving
   * requests. FalkorDB accepts a multi-property range index (v4.22.1); older
   * deployments may already have single-property indexes, in which case we
   * preserve them and ensure each required property remains indexed.
   */
  async bootstrap(): Promise<void> {
    // GRAPH.RO_QUERY cannot operate on a graph key FalkorDB has not created yet.
    // checkHealth initializes only that empty graph case before schema probes.
    await this.checkHealth();
    await this.ensureLookupIndexes();
  }

  private async ensureLookupIndexes(): Promise<void> {
    const definitions = [
      { label: 'Service', properties: ['org_id', 'id'] },
      { label: 'Incident', properties: ['org_id', 'id'] },
    ] as const;

    for (const definition of definitions) {
      let indexes = await this.getIndexes();
      const existing = indexes
        .filter((row) => row.label === definition.label)
        .map((row) => row.properties);
      if (existing.some((properties) => sameProperties(properties, definition.properties)))
        continue;

      const overlaps = existing.some((properties) =>
        definition.properties.some((property) => properties.includes(property))
      );
      if (!overlaps) {
        try {
          await this.graph.query(`CREATE INDEX FOR (n:${definition.label}) ON (n.org_id, n.id)`);
          continue;
        } catch (error) {
          // Concurrent process startup can race while adding the same index.
          indexes = await this.getIndexes();
          const created = indexes
            .filter((row) => row.label === definition.label)
            .some((row) => sameProperties(row.properties, definition.properties));
          if (created) continue;
          throw error;
        }
      }

      // A pre-existing partial index cannot be combined with the composite
      // index without dropping user data structures. Add only missing safe
      // single-property indexes and keep the existing schema intact.
      for (const property of definition.properties) {
        indexes = await this.getIndexes();
        const alreadyIndexed = indexes
          .filter((row) => row.label === definition.label)
          .some((row) => row.properties.includes(property));
        if (alreadyIndexed) continue;
        try {
          await this.graph.query(`CREATE INDEX FOR (n:${definition.label}) ON (n.${property})`);
        } catch (error) {
          indexes = await this.getIndexes();
          const created = indexes
            .filter((row) => row.label === definition.label)
            .some((row) => row.properties.includes(property));
          if (!created) throw error;
        }
      }
    }
  }

  private async getIndexes(): Promise<Array<{ label: string; properties: string[] }>> {
    const result = await this.graph.roQuery<unknown[]>('CALL db.indexes()');
    return this.toRows(result).flatMap((row) => {
      const label = typeof row.label === 'string' ? row.label : undefined;
      const properties = Array.isArray(row.properties)
        ? row.properties.filter((property): property is string => typeof property === 'string')
        : [];
      return label && properties.length ? [{ label, properties }] : [];
    });
  }

  async checkHealth(): Promise<void> {
    try {
      await this.graph.roQuery('MATCH (n) RETURN count(n) AS health');
    } catch (error) {
      // RO_QUERY returns "Invalid graph operation on empty key" for a brand-new
      // selected graph. A harmless GRAPH.QUERY creates its key; then retry the
      // read-only probe. Do not mask network, permission, or query errors.
      if (!(error instanceof Error) || !error.message.toLowerCase().includes('empty key'))
        throw error;
      await this.graph.query('RETURN 1 AS health');
      await this.graph.roQuery('MATCH (n) RETURN count(n) AS health');
    }
  }

  async upsertService(input: {
    orgId: string;
    id: string;
    name: string;
    serviceType?: string;
    owner?: string;
    aggregateVersion?: number;
  }): Promise<void> {
    await this.graph.query(
      `MERGE (s:Service {org_id: $orgId, id: $id})
       ON CREATE SET s.created_at = timestamp()
       WITH s WHERE ($aggregateVersion IS NULL AND coalesce(s.catalog_version, 0) = 0)
         OR ($aggregateVersion IS NOT NULL AND coalesce(s.catalog_version, 0) < $aggregateVersion)
       SET s.name = $name,
           s.type = $serviceType,
           s.owner = $owner,
           s.updated_at = timestamp(),
           s.catalog_version = coalesce($aggregateVersion, coalesce(s.catalog_version, 0))`,
      {
        params: {
          orgId: input.orgId,
          id: input.id,
          name: input.name,
          serviceType: input.serviceType || 'service',
          owner: input.owner || '',
          aggregateVersion: input.aggregateVersion ?? null,
        },
      }
    );
  }

  async linkDependency(input: {
    orgId: string;
    dependentId: string;
    dependencyId: string;
    criticality?: 'critical' | 'degraded' | 'optional';
    aggregateVersion?: number;
  }): Promise<void> {
    await this.graph.query(
      `MERGE (dependent:Service {org_id: $orgId, id: $dependentId})
       ON CREATE SET dependent.name = $dependentId, dependent.type = 'service'
       MERGE (dependency:Service {org_id: $orgId, id: $dependencyId})
       ON CREATE SET dependency.name = $dependencyId, dependency.type = 'service'
       MERGE (dependent)-[r:DEPENDS_ON]->(dependency)
       WITH r WHERE ($aggregateVersion IS NULL AND coalesce(r.catalog_version, 0) = 0)
         OR ($aggregateVersion IS NOT NULL AND coalesce(r.catalog_version, 0) < $aggregateVersion)
       SET r.org_id = $orgId, r.criticality = $criticality, r.updated_at = timestamp(),
           r.catalog_version = coalesce($aggregateVersion, coalesce(r.catalog_version, 0))`,
      {
        params: {
          orgId: input.orgId,
          dependentId: input.dependentId,
          dependencyId: input.dependencyId,
          criticality: input.criticality || 'degraded',
          aggregateVersion: input.aggregateVersion ?? null,
        },
      }
    );
  }

  async linkIncidentToService(input: {
    orgId: string;
    incidentId: string;
    title: string;
    serviceId: string;
    aggregateVersion?: number;
  }): Promise<void> {
    await this.graph.query(
      `MERGE (i:Incident {org_id: $orgId, id: $incidentId})
       MERGE (s:Service {org_id: $orgId, id: $serviceId})
       ON CREATE SET s.name = $serviceId, s.type = 'service'
       MERGE (i)-[r:AFFECTS]->(s)
       WITH i,r WHERE ($aggregateVersion IS NULL AND coalesce(r.catalog_version, 0) = 0)
         OR ($aggregateVersion IS NOT NULL AND coalesce(r.catalog_version, 0) < $aggregateVersion)
       SET i.title = $title, i.updated_at = timestamp(), r.org_id = $orgId,
           r.catalog_version = coalesce($aggregateVersion, coalesce(r.catalog_version, 0))`,
      {
        params: {
          orgId: input.orgId,
          incidentId: input.incidentId,
          title: input.title,
          serviceId: input.serviceId,
          aggregateVersion: input.aggregateVersion ?? null,
        },
      }
    );
  }

  async unlinkDependency(input: {
    orgId: string;
    dependentId: string;
    dependencyId: string;
    aggregateVersion?: number;
  }): Promise<void> {
    await this.graph.query(
      `MATCH (dependent:Service {org_id: $orgId, id: $dependentId})
       -[r:DEPENDS_ON {org_id: $orgId}]->
       (dependency:Service {org_id: $orgId, id: $dependencyId})
       WHERE ($aggregateVersion IS NULL AND coalesce(r.catalog_version, 0) = 0)
          OR ($aggregateVersion IS NOT NULL AND coalesce(r.catalog_version, 0) < $aggregateVersion)
       DELETE r`,
      { params: input }
    );
  }

  async unlinkIncidentFromService(input: {
    orgId: string;
    incidentId: string;
    serviceId: string;
    aggregateVersion?: number;
  }): Promise<void> {
    await this.graph.query(
      `MATCH (incident:Incident {org_id: $orgId, id: $incidentId})
       -[r:AFFECTS {org_id: $orgId}]->
       (service:Service {org_id: $orgId, id: $serviceId})
       WHERE ($aggregateVersion IS NULL AND coalesce(r.catalog_version, 0) = 0)
          OR ($aggregateVersion IS NOT NULL AND coalesce(r.catalog_version, 0) < $aggregateVersion)
       DELETE r`,
      { params: input }
    );
  }

  async deleteService(input: {
    orgId: string;
    id: string;
    aggregateVersion?: number;
  }): Promise<void> {
    await this.graph.query(
      `MATCH (service:Service {org_id: $orgId, id: $id})
       WHERE ($aggregateVersion IS NULL AND coalesce(service.catalog_version, 0) = 0)
          OR ($aggregateVersion IS NOT NULL AND coalesce(service.catalog_version, 0) < $aggregateVersion)
       DETACH DELETE service`,
      { params: input }
    );
  }

  /** Removes a tenant projection without touching nodes or edges from other organizations. */
  async deleteOrganization(orgId: string): Promise<void> {
    await this.graph.query(
      `MATCH (a)-[r:DEPENDS_ON {org_id: $orgId}]->(b)
       WHERE a.org_id = $orgId AND b.org_id = $orgId
       DELETE r`,
      { params: { orgId } }
    );
    await this.graph.query(`MATCH (i:Incident {org_id: $orgId}) DETACH DELETE i`, {
      params: { orgId },
    });
    await this.graph.query(`MATCH (s:Service {org_id: $orgId}) DETACH DELETE s`, {
      params: { orgId },
    });
  }

  async getServiceNeighborhood(
    orgId: string,
    serviceId: string
  ): Promise<ServiceNeighborhoodItem[]> {
    const result = await this.graph.roQuery<unknown[]>(
      `MATCH (s:Service {org_id: $orgId, id: $serviceId})-[r:DEPENDS_ON]-(neighbor:Service)
       WHERE neighbor.org_id = $orgId
       RETURN DISTINCT neighbor.id AS id,
              neighbor.name AS name,
              type(r) AS relationship,
              CASE WHEN startNode(r) = s THEN 'downstream' ELSE 'upstream' END AS direction
       ORDER BY name
       LIMIT 100`,
      { params: { orgId, serviceId } }
    );
    return this.toRows(result).flatMap((row) => {
      if (typeof row.id !== 'string' || typeof row.name !== 'string') return [];
      return [
        {
          id: row.id,
          name: row.name,
          relationship: String(row.relationship || 'DEPENDS_ON'),
          direction: row.direction === 'downstream' ? 'downstream' : 'upstream',
        },
      ];
    });
  }

  async findRelatedIncidents(orgId: string, incidentId: string): Promise<RelatedIncident[]> {
    const result = await this.graph.roQuery<unknown[]>(
      `MATCH (current:Incident {org_id: $orgId, id: $incidentId})-[:AFFECTS]->(s:Service)
       MATCH (past:Incident {org_id: $orgId})-[:AFFECTS]->(s)
       WHERE s.org_id = $orgId AND past.id <> current.id
         AND ALL(n IN [current, past, s] WHERE n.org_id = $orgId)
       WITH past, collect(DISTINCT s.name) AS sharedServices
       RETURN past.id AS id, past.title AS title, sharedServices
       ORDER BY size(sharedServices) DESC, id
       LIMIT 20`,
      { params: { orgId, incidentId } }
    );
    return this.toRows(result).flatMap((row) => {
      if (typeof row.id !== 'string') return [];
      const sharedServices = Array.isArray(row.sharedServices)
        ? row.sharedServices.filter((service): service is string => typeof service === 'string')
        : [];
      return [
        {
          id: row.id,
          title: typeof row.title === 'string' ? row.title : row.id,
          sharedServices,
        },
      ];
    });
  }

  async findIncidentEvidencePaths(
    orgId: string,
    incidentId: string,
    maxDepth = 3,
    signal?: AbortSignal
  ): Promise<IncidentEvidencePath[]> {
    if (signal?.aborted) throw signal.reason ?? new Error('Graph evidence lookup cancelled');
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) {
      throw new Error('Graph traversal depth must be an integer from 1 through 4');
    }
    // FalkorDB 6.6 Graph.roQuery accepts QueryOptions with params and TIMEOUT.
    // Its client API has no per-query AbortSignal, so keep caller-side work
    // tracked until it settles and bound server execution independently.
    const result = await this.graph.roQuery<unknown[]>(
      `MATCH path=(current:Incident {org_id: $orgId, id: $incidentId})-[:AFFECTS]->(root:Service)-[:DEPENDS_ON*0..${maxDepth}]-(target:Service)<-[:AFFECTS]-(related:Incident {org_id: $orgId})
       WHERE related.id <> current.id AND ALL(n IN nodes(path) WHERE n.org_id = $orgId)
       RETURN DISTINCT current.id AS rootIncidentId,
              current.title AS rootIncidentTitle,
              related.id AS incidentId,
              related.title AS incidentTitle,
              [n IN nodes(path) WHERE 'Service' IN labels(n) | {id: n.id, name: n.name}] AS services,
              [r IN relationships(path) | {from: startNode(r).id, to: endNode(r).id, relationship: type(r), criticality: r.criticality}] AS edges
       ORDER BY incidentTitle, incidentId
       LIMIT 50`,
      { params: { orgId, incidentId }, TIMEOUT: GRAPH_EVIDENCE_QUERY_TIMEOUT_MS }
    );
    return this.toRows(result).flatMap((row) => {
      if (typeof row.incidentId !== 'string') return [];
      if (typeof row.rootIncidentId !== 'string') return [];
      const services = toObjectRows(row.services).flatMap((service) =>
        typeof service.id === 'string'
          ? [{ id: service.id, name: typeof service.name === 'string' ? service.name : service.id }]
          : []
      );
      const edges = toObjectRows(row.edges).flatMap((edge) =>
        typeof edge.from === 'string' && typeof edge.to === 'string'
          ? [
              {
                from: edge.from,
                to: edge.to,
                relationship:
                  typeof edge.relationship === 'string' ? edge.relationship : 'DEPENDS_ON',
                ...(typeof edge.criticality === 'string' ? { criticality: edge.criticality } : {}),
              },
            ]
          : []
      );
      const title = typeof row.incidentTitle === 'string' ? row.incidentTitle : row.incidentId;
      const serviceNames = services.map((service) => service.name);
      return [
        {
          rootIncidentId: row.rootIncidentId,
          rootIncidentTitle:
            typeof row.rootIncidentTitle === 'string' ? row.rootIncidentTitle : row.rootIncidentId,
          incidentId: row.incidentId,
          incidentTitle: title,
          services,
          edges,
          rationale: `${title} is connected through ${serviceNames.join(' → ') || 'a shared service'}.`,
        },
      ];
    });
  }

  private toRows(result: { headers?: string[]; data?: unknown[] }): GraphRow[] {
    const headers = result.headers || [];
    return (result.data || []).flatMap((item) => {
      if (!Array.isArray(item)) {
        return item && typeof item === 'object' ? [item as GraphRow] : [];
      }
      return [Object.fromEntries(headers.map((header, index) => [header, item[index]]))];
    });
  }
}

function toObjectRows(value: unknown): GraphRow[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is GraphRow => !!entry && typeof entry === 'object' && !Array.isArray(entry)
      )
    : [];
}

function sameProperties(actual: string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && expected.every((property) => actual.includes(property))
  );
}

export async function connectFalkorDB(
  url: string,
  graphName = 'runbook'
): Promise<FalkorDBConnection> {
  const client = await FalkorDB.connect({ url });
  // FalkorDB forwards node-redis socket errors through EventEmitter. Without a
  // listener, a transient disconnect (for example during a database restart)
  // becomes an uncaught exception and terminates the API process.
  client.on('error', () => {
    console.error('FalkorDB client connection error');
  });
  const store = new FalkorDBStore(client.selectGraph(graphName));
  try {
    await store.bootstrap();
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    store,
    close: () => client.close(),
  };
}
