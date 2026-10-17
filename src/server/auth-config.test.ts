import { createServer, type Server } from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../utils/config';
import type { IKnowledgeRetriever } from '../knowledge/retriever/types';
import { createRouter } from './router';

let server: Server | undefined;

async function getAuthConfig(organizations: string[], graphOrgId = 'default') {
  const handler = createRouter({
    apiKey: 'auth-config-test-api-key-32-bytes',
    retriever: {} as IKnowledgeRetriever,
    mcpServer: {} as never,
    version: 'auth-config-test',
    config: DEFAULT_CONFIG,
    graphOrgId,
    auth0OrgIds: organizations,
    auth0Config: {
      domain: 'tenant.example.auth0.com',
      clientId: 'public-client',
      audience: 'https://api.example.test',
      issuer: 'https://tenant.example.auth0.com/',
    },
  });
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/config`);
  return response.json();
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve()))
  );
  server = undefined;
});

describe('public Auth0 dashboard configuration', () => {
  it('provides only the configured organization allowlist for Auth0 login', async () => {
    await expect(getAuthConfig(['org_acme', 'org_beta'])).resolves.toMatchObject({
      data: { enabled: true, organizations: ['org_acme', 'org_beta'] },
    });
  });

  it('does not expose the legacy default tenant as an Auth0 organization', async () => {
    await expect(getAuthConfig(['default'])).resolves.toMatchObject({
      data: { enabled: true, organizations: [] },
    });
  });
});
