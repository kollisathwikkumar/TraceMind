import type { Config } from '../utils/config';
import type { IncidentEvidencePath } from '../knowledge/store/falkordb-store';

export interface GraphContextSettings {
  url?: string;
  graphName: string;
  orgId: string;
}

/** Resolve CLI graph settings using the same environment overrides as the server. */
export function resolveGraphContextSettings(
  graph: Config['graph'],
  environment: NodeJS.ProcessEnv = process.env
): GraphContextSettings {
  return {
    url:
      environment.TRACEMIND_FALKORDB_URL || environment.RUNBOOK_FALKORDB_URL || graph.falkordbUrl,
    graphName: environment.TRACEMIND_FALKORDB_GRAPH_NAME || graph.graphName,
    orgId: environment.TRACEMIND_ORG_ID || graph.orgId,
  };
}

/** Format graph relationships as traceable correlation evidence, never a causal conclusion. */
export function formatIncidentEvidencePaths(
  paths: IncidentEvidencePath[],
  settings: Pick<GraphContextSettings, 'graphName' | 'orgId'>
): string[] {
  return paths.slice(0, 8).map((path) => {
    const servicePath = path.services
      .map((service) => `${service.name} [${service.id}]`)
      .join(' → ');
    const edgePath = path.edges
      .map(
        (edge) =>
          `${edge.from} -[${edge.relationship}${edge.criticality ? `; criticality=${edge.criticality}` : ''}]-> ${edge.to}`
      )
      .join(' | ');
    return [
      `Source: FalkorDB graph "${settings.graphName}"; organization "${settings.orgId}".`,
      `Related incident: ${path.incidentTitle} [${path.incidentId}] (current incident: ${path.rootIncidentTitle} [${path.rootIncidentId}]).`,
      `Service path: ${servicePath || 'not returned'}.`,
      `Relationships: ${edgePath || 'not returned'}.`,
      `Graph rationale: ${path.rationale}`,
      'Interpretation: topology correlation only; this path does not establish root cause or causation.',
    ].join(' ');
  });
}
