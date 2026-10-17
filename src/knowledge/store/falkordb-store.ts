/**
 * FalkorDB projection for incident/service relationships.
 * PostgreSQL remains the future system of record; this adapter owns only graph
 * projections and graph-assisted retrieval.
 */

import { FalkorDB } from 'falkordb';

export interface GraphRow {
  [key: string]: unknown;
}

export interface FalkorGraphPort {
  query<T = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
  ): Promise<{ headers?: string[]; data?: T[] }>;
  roQuery<T = unknown>(
    query: string,
    options?: { params?: Record<string, unknown> }
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

  async checkHealth(): Promise<void> {
    // FalkorDB RO_QUERY requires a graph operation; bare RETURN can be parsed as
    // an operation against an empty graph key and fail even when the graph is healthy.
    await this.graph.roQuery('MATCH (n) RETURN count(n) AS health');
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
       SET r.criticality = $criticality, r.updated_at = timestamp(),
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
       SET i.title = $title, i.updated_at = timestamp(),
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
       WHERE past.id <> current.id
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
    maxDepth = 3
  ): Promise<IncidentEvidencePath[]> {
    if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 4) {
      throw new Error('Graph traversal depth must be an integer from 1 through 4');
    }
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
      { params: { orgId, incidentId } }
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
  return {
    store: new FalkorDBStore(client.selectGraph(graphName)),
    close: () => client.close(),
  };
}
