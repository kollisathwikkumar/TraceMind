import { describe, expect, it } from 'vitest';
import type { Config } from '../../utils/config';
import type { IncidentEvidencePath } from '../../knowledge/store/falkordb-store';
import { formatIncidentEvidencePaths, resolveGraphContextSettings } from '../graph-context';

describe('CLI FalkorDB graph context', () => {
  const graphConfig: Config['graph'] = {
    falkordbUrl: undefined,
    graphName: 'runbook',
    orgId: 'default',
  };

  it('uses configured FalkorDB URL, graph name, and organization by default', () => {
    expect(
      resolveGraphContextSettings(
        {
          ...graphConfig,
          falkordbUrl: 'redis://configured:6379',
          graphName: 'configured-graph',
          orgId: 'configured-org',
        },
        {}
      )
    ).toEqual({
      url: 'redis://configured:6379',
      graphName: 'configured-graph',
      orgId: 'configured-org',
    });
  });

  it('honors TraceMind environment overrides for endpoint, graph, and tenant', () => {
    expect(
      resolveGraphContextSettings(graphConfig, {
        TRACEMIND_FALKORDB_URL: 'rediss://primary:6379',
        RUNBOOK_FALKORDB_URL: 'redis://legacy:6379',
        TRACEMIND_FALKORDB_GRAPH_NAME: 'trace-prod',
        TRACEMIND_ORG_ID: 'org-acme',
      })
    ).toEqual({ url: 'rediss://primary:6379', graphName: 'trace-prod', orgId: 'org-acme' });
  });

  it('uses the legacy URL alias only when the primary URL is absent', () => {
    expect(
      resolveGraphContextSettings(graphConfig, {
        RUNBOOK_FALKORDB_URL: 'redis://legacy:6379',
      }).url
    ).toBe('redis://legacy:6379');
  });

  it('returns no findings for an empty graph result rather than inventing a causal claim', () => {
    expect(formatIncidentEvidencePaths([], { graphName: 'g', orgId: 'org-a' })).toEqual([]);
  });

  it('formats multi-hop paths, relationship provenance, and correlation caveat', () => {
    const evidence: IncidentEvidencePath = {
      rootIncidentId: 'inc-current',
      rootIncidentTitle: 'Checkout errors',
      incidentId: 'inc-prior',
      incidentTitle: 'Database saturation',
      services: [
        { id: 'checkout', name: 'Checkout' },
        { id: 'database', name: 'Database' },
      ],
      edges: [
        { from: 'inc-current', to: 'checkout', relationship: 'AFFECTS' },
        { from: 'checkout', to: 'database', relationship: 'DEPENDS_ON', criticality: 'critical' },
        { from: 'inc-prior', to: 'database', relationship: 'AFFECTS' },
      ],
      rationale: 'Prior incident is connected through Checkout → Database.',
    };

    const [finding] = formatIncidentEvidencePaths([evidence], {
      graphName: 'trace-prod',
      orgId: 'org-acme',
    });
    expect(finding).toContain('FalkorDB graph "trace-prod"; organization "org-acme"');
    expect(finding).toContain('Database saturation [inc-prior]');
    expect(finding).toContain('Checkout [checkout] → Database [database]');
    expect(finding).toContain('DEPENDS_ON; criticality=critical');
    expect(finding).toContain('Graph rationale: Prior incident is connected');
    expect(finding).toContain('topology correlation only');
    expect(finding).toContain('does not establish root cause or causation');
  });
});
