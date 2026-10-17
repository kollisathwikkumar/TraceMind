import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../utils/config';
import type { IKnowledgeRetriever } from '../../knowledge/retriever/types';
import { IncidentStore } from '../incidents/store';
import { WorkflowStore } from '../workflows/store';
import { createAuth0TokenVerifier, type Auth0Config } from '../auth0';
import { createRouter } from '../router';

const auth0: Auth0Config = {
  domain: 'local-test.auth0.invalid',
  clientId: 'local-test-client',
  audience: 'https://api.tracemind.test',
  issuer: 'https://local-test.auth0.invalid/',
};

let server: Server | undefined;
let incidents: IncidentStore | undefined;
let workflows: WorkflowStore | undefined;
let dir: string | undefined;
const databasePath = () => join(dir!, 'auth0-integration.sqlite');

async function listen(handler: ReturnType<typeof createRouter>): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) =>
    server!.close((error) => (error ? reject(error) : resolve()))
  );
  server = undefined;
}

function makeRouter(
  verifyAuth0Token: (
    token: string
  ) => Promise<
    Awaited<ReturnType<typeof createAuth0TokenVerifier>> extends never
      ? never
      : import('../auth0').Auth0Identity | undefined
  >
) {
  incidents = new IncidentStore(databasePath());
  workflows = new WorkflowStore(databasePath());
  return createRouter({
    apiKey: 'local-harness-api-key',
    retriever: { close: () => {} } as unknown as IKnowledgeRetriever,
    mcpServer: { close: () => {} } as never,
    version: 'auth0-local-harness',
    config: DEFAULT_CONFIG,
    incidentStore: incidents,
    workflowStore: workflows,
    auth0Config: auth0,
    auth0OrgIds: ['org-alpha', 'org-beta'],
    verifyAuth0Token,
  });
}

afterEach(async () => {
  await stopServer();
  incidents?.close();
  workflows?.close();
  incidents = undefined;
  workflows = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('local Auth0 JWT → HTTP → tenant persistence integration', () => {
  it('selects a tenant-bound knowledge retriever from the authenticated organization', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({
      keys: [{ ...jwk, kid: 'local-test-key', alg: 'RS256', use: 'sig' }],
    });
    const verify = createAuth0TokenVerifier(auth0, jwks);
    const mint = (organizationId: string) =>
      new SignJWT({ org_id: organizationId, scope: 'knowledge:read' })
        .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
        .setIssuer(auth0.issuer)
        .setAudience(auth0.audience)
        .setSubject(`auth0|${organizationId}`)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    const resolvedTenants: string[] = [];
    const makeTenantRetriever = (tenantId: string): IKnowledgeRetriever =>
      ({
        search: async () => {
          resolvedTenants.push(tenantId);
          return { runbooks: [], postmortems: [], architecture: [], knownIssues: [] };
        },
        close: () => {},
      }) as unknown as IKnowledgeRetriever;
    const handler = createRouter({
      apiKey: 'local-harness-api-key',
      retriever: makeTenantRetriever('default'),
      retrieverForTenant: async (tenantId) => makeTenantRetriever(tenantId),
      mcpServer: { close: () => {} } as never,
      version: 'tenant-knowledge-test',
      config: DEFAULT_CONFIG,
      auth0Config: auth0,
      auth0OrgIds: ['org-alpha', 'org-beta'],
      verifyAuth0Token: verify,
    });
    const base = await listen(handler);
    for (const tenantId of ['org-alpha', 'org-beta']) {
      const token = await mint(tenantId);
      const response = await fetch(`${base}/api/v1/knowledge/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'tenant isolation' }),
      });
      expect(response.status).toBe(200);
    }
    expect(resolvedTenants).toEqual(['org-alpha', 'org-beta']);
  });

  it('verifies real signed tokens, enforces org/scopes, and retains CRUD across a server restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tracemind-auth0-local-'));
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const jwks = createLocalJWKSet({
      keys: [{ ...jwk, kid: 'local-test-key', alg: 'RS256', use: 'sig' }],
    });
    const verify = createAuth0TokenVerifier(auth0, jwks);
    const mint = (
      subject: string,
      organizationId: string,
      scopes: string[],
      overrides: { audience?: string; issuer?: string } = {}
    ) =>
      new SignJWT({ org_id: organizationId, scope: scopes.join(' ') })
        .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
        .setIssuer(overrides.issuer ?? auth0.issuer)
        .setAudience(overrides.audience ?? auth0.audience)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);

    const alice = await mint('auth0|local-alice', 'org-alpha', [
      'incidents:read',
      'incidents:write',
    ]);
    const missingOrganization = await new SignJWT({ scope: 'incidents:read' })
      .setProtectedHeader({ alg: 'RS256', kid: 'local-test-key' })
      .setIssuer(auth0.issuer)
      .setAudience(auth0.audience)
      .setSubject('auth0|missing-organization')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const alphaReader = await mint('auth0|alpha-reader', 'org-alpha', ['incidents:read']);
    const betaUser = await mint('auth0|beta-user', 'org-beta', ['incidents:read']);
    const foreignTenant = await mint('auth0|foreign', 'org-not-enabled', ['incidents:read']);
    const wrongAudience = await mint('auth0|wrong-aud', 'org-alpha', ['incidents:read'], {
      audience: 'https://wrong.example.test',
    });
    const wrongIssuer = await mint('auth0|wrong-iss', 'org-alpha', ['incidents:read'], {
      issuer: 'https://attacker.example.test/',
    });

    let base = await listen(makeRouter(verify));
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });

    const created = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: headers(alice),
      body: JSON.stringify({
        title: 'Local Auth0 integration incident',
        description: 'test-only',
        severity: 'SEV-3',
      }),
    });
    expect(created.status).toBe(201);
    const { data: record } = (await created.json()) as { data: { id: string; title: string } };
    expect(record.title).toBe('Local Auth0 integration incident');

    expect(
      (await fetch(`${base}/api/v1/incidents`, { headers: headers(alphaReader) })).status
    ).toBe(200);
    const missingOrganizationResponse = await fetch(`${base}/api/v1/incidents`, {
      headers: headers(missingOrganization),
    });
    expect(missingOrganizationResponse.status).toBe(403);
    expect(await missingOrganizationResponse.json()).toMatchObject({
      error: { code: 'tenant_required' },
    });
    const deniedWrite = await fetch(`${base}/api/v1/incidents`, {
      method: 'POST',
      headers: headers(alphaReader),
      body: JSON.stringify({ title: 'must not be created', severity: 'SEV-3' }),
    });
    expect(deniedWrite.status).toBe(403);
    expect(
      (await fetch(`${base}/api/v1/incidents`, { headers: headers(foreignTenant) })).status
    ).toBe(403);
    expect(
      (await fetch(`${base}/api/v1/incidents`, { headers: headers(wrongAudience) })).status
    ).toBe(401);
    expect(
      (await fetch(`${base}/api/v1/incidents`, { headers: headers(wrongIssuer) })).status
    ).toBe(401);
    expect(
      await (await fetch(`${base}/api/v1/incidents`, { headers: headers(betaUser) })).json()
    ).toMatchObject({ data: [] });

    // Reopen the same SQLite file with fresh repository instances, modeling a process restart.
    await stopServer();
    incidents!.close();
    workflows!.close();
    incidents = undefined;
    workflows = undefined;
    base = await listen(makeRouter(verify));
    const afterRestart = await fetch(`${base}/api/v1/incidents/${record.id}`, {
      headers: headers(alice),
    });
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toMatchObject({
      data: { id: record.id, title: 'Local Auth0 integration incident' },
    });
    expect(
      (await fetch(`${base}/api/v1/incidents/${record.id}`, { headers: headers(betaUser) })).status
    ).toBe(404);

    // Keep this harness independent of optional external services and assert its persistent state directly.
    const db = new Database(databasePath(), { readonly: true });
    try {
      expect(db.prepare('SELECT tenant_id FROM incidents WHERE id = ?').get(record.id)).toEqual({
        tenant_id: 'org-alpha',
      });
    } finally {
      db.close();
    }
  });
});
