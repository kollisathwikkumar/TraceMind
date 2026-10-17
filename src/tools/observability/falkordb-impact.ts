import type { Tool } from '../../agent/types';
import {
  connectFalkorDB,
  type FalkorDBConnection,
  type IncidentEvidencePath,
} from '../../knowledge/store/falkordb-store';
import { loadConfig } from '../../utils/config';
import { resolveGraphContextSettings } from '../../cli/graph-context';

const MAX_DEPTH = 4;
const MAX_RESULTS = 10;

interface GraphSettings {
  url?: string;
  graphName: string;
  orgId: string;
}

interface GraphImpactToolDependencies {
  settings(): Promise<GraphSettings>;
  connect(url: string, graphName: string): Promise<FalkorDBConnection>;
}

const defaultDependencies: GraphImpactToolDependencies = {
  async settings() {
    const config = await loadConfig();
    return resolveGraphContextSettings(config.graph);
  },
  connect: connectFalkorDB,
};

/**
 * An agent-callable, read-only FalkorDB topology query. Tenant identity always
 * comes from trusted runtime configuration; callers cannot choose an org.
 */
export function createFalkorImpactTool(
  dependencies: GraphImpactToolDependencies = defaultDependencies
): Tool {
  return {
    name: 'falkordb_incident_impact',
    description:
      'Query FalkorDB for bounded multi-hop service-topology paths connecting an incident to related incidents. This returns explainable correlation evidence, not causal proof. The organization is taken from trusted TraceMind configuration, never from tool arguments.',
    parameters: {
      type: 'object',
      properties: {
        incidentId: {
          type: 'string',
          description: 'Incident identifier to investigate in the configured organization.',
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum dependency traversal depth (1-4; defaults to 3).',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum returned paths (1-10; defaults to 5).',
        },
      },
      required: ['incidentId'],
    },
    async execute(args) {
      const incidentId = typeof args.incidentId === 'string' ? args.incidentId.trim() : '';
      if (!incidentId || incidentId.length > 200) {
        return { error: 'incidentId must be a non-empty string no longer than 200 characters.' };
      }
      const maxDepth = args.maxDepth === undefined ? 3 : args.maxDepth;
      if (
        typeof maxDepth !== 'number' ||
        !Number.isInteger(maxDepth) ||
        maxDepth < 1 ||
        maxDepth > MAX_DEPTH
      ) {
        return { error: `maxDepth must be an integer from 1 through ${MAX_DEPTH}.` };
      }
      const maxResults = args.maxResults === undefined ? 5 : args.maxResults;
      if (
        typeof maxResults !== 'number' ||
        !Number.isInteger(maxResults) ||
        maxResults < 1 ||
        maxResults > MAX_RESULTS
      ) {
        return { error: `maxResults must be an integer from 1 through ${MAX_RESULTS}.` };
      }

      const settings = await dependencies.settings();
      if (!settings.url) return { error: 'FalkorDB is not configured.' };
      const connection = await dependencies.connect(settings.url, settings.graphName);
      try {
        const paths = await connection.store.findIncidentEvidencePaths(
          settings.orgId,
          incidentId,
          maxDepth
        );
        return formatImpactResult(paths, settings, incidentId, maxDepth, maxResults);
      } finally {
        await connection.close();
      }
    },
  };
}

function formatImpactResult(
  paths: IncidentEvidencePath[],
  settings: GraphSettings,
  incidentId: string,
  maxDepth: number,
  maxResults: number
) {
  return {
    source: 'FalkorDB',
    graph: settings.graphName,
    organization: settings.orgId,
    query: { incidentId, maxDepth, maxResults },
    returned: Math.min(paths.length, maxResults),
    truncated: paths.length > maxResults,
    interpretation: 'Topology correlation evidence only; paths do not establish causation.',
    paths: paths.slice(0, maxResults).map((path) => ({
      rootIncident: { id: path.rootIncidentId, title: path.rootIncidentTitle },
      relatedIncident: { id: path.incidentId, title: path.incidentTitle },
      services: path.services,
      edges: path.edges,
      rationale: path.rationale,
    })),
    provenance: {
      organization: settings.orgId,
      graph: settings.graphName,
      relationshipTypes: ['AFFECTS', 'DEPENDS_ON'],
    },
  };
}
