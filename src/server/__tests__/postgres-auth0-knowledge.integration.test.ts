import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../utils/config';
import { createConfiguredRetriever } from '../../knowledge/retriever/index';
import type { IKnowledgeRetriever } from '../../knowledge/retriever/types';
import type { KnowledgeDocument } from '../../knowledge/types';
import { PostgresKnowledgeStore, migratePostgresKnowledge } from '../../knowledge/store/postgres';
import {
  PostgresVectorStore,
  migratePostgresVectorStore,
} from '../../knowledge/store/postgres-vector-store';
import { createAuth0TokenVerifier, type Auth0Config } from '../auth0';
import { createRouter } from '../router';

const connectionString = process.env.RUNBOOK_TEST_DATABASE_URL;
const auth0: Auth0Config = {
  domain: 'postgres-test.auth0.invalid',
  clientId: 'postgres-test-client',
  audience: 'https://api.tracemind.test',
  issuer: 'https://postgres-test.auth0.invalid/',
};

let server: Server | undefined;
let pool: Pool | undefined;
let admin: Pool | undefined;
let baseDir: string | undefined;
let tenantRetrievers: IKnowledgeRetriever[] = [];

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

function knowledgeDocument(id: string, title: string): KnowledgeDocument {
  return {
    id,
    source: {
      type: 'api',
      name: 'integration-test',
      config: { type: 'api', endpoint: 'https://example.test' },
    },
    type: 'runbook',
    title,
    content: `Private content for ${id}`,
    chunks: [],
    services: ['worker'],
    tags: [],
    severityRelevance: [],
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
  };
}

describe('Auth0 + PostgreSQL knowledge CRUD/restart integration', () => {
  afterEach(async () => {
    await stopServer();
    for (const retriever of tenantRetrievers) retriever.close();
    tenantRetrievers = [];
    await pool?.end();
    pool = undefined;
    if (admin) {
      if (schemaName) await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.end();
      admin = undefined;
    }
    if (baseDir) rmSync(baseDir, { recursive: true, force: true });
    baseDir = undefined;
    schemaName = undefined;
  });

  let schemaName: string | undefined;
  it.skipIf(!connectionString)(
    'isolates Auth0 organization knowledge and preserves authenticated CRUD across restart',
    async () => {
      schemaName = `auth0_knowledge_${randomUUID().replaceAll('-', '')}`;
      admin = new Pool({ connectionString });
      await admin.query(`CREATE SCHEMA "${schemaName}"`);
      baseDir = mkdtempSync(join(tmpdir(), 'tracemind-auth0-pg-'));

      const { publicKey, privateKey } = await generateKeyPair('RS256');
      const jwk = await exportJWK(publicKey);
      const verify = createAuth0TokenVerifier(
        auth0,
        createLocalJWKSet({
          keys: [{ ...jwk, kid: 'postgres-test-key', alg: 'RS256', use: 'sig' }],
        })
      );
      const mint = (tenantId: string, scope: string) =>
        new SignJWT({ org_id: tenantId, scope })
          .setProtectedHeader({ alg: 'RS256', kid: 'postgres-test-key' })
          .setIssuer(auth0.issuer)
          .setAudience(auth0.audience)
          .setSubject(`auth0|${tenantId}`)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
      const alphaRead = await mint('org-alpha', 'knowledge:read');
      const alphaWrite = await mint('org-alpha', 'knowledge:write');
      const betaRead = await mint('org-beta', 'knowledge:read');

      const openApp = async () => {
        pool = new Pool({ connectionString, options: `-c search_path=${schemaName}` });
        await migratePostgresKnowledge(pool);
        await migratePostgresVectorStore(pool);
        const cache = new Map<string, Promise<IKnowledgeRetriever>>();
        const forTenant = async (tenantId: string) => {
          let item = cache.get(tenantId);
          if (!item) {
            item = createConfiguredRetriever(baseDir!, DEFAULT_CONFIG, {
              knowledge: new PostgresKnowledgeStore(pool!, tenantId, false),
              vector: new PostgresVectorStore(pool!, { tenantId, embedText: async () => [1] }),
            });
            cache.set(tenantId, item);
            const resolved = await item;
            tenantRetrievers.push(resolved);
            return resolved;
          }
          return item;
        };
        const handler = createRouter({
          apiKey: 'postgres-test-api-key',
          retriever: await forTenant('org-alpha'),
          retrieverForTenant: forTenant,
          mcpServer: { close: () => {} } as never,
          version: 'postgres-auth0-test',
          config: DEFAULT_CONFIG,
          auth0Config: auth0,
          auth0OrgIds: ['org-alpha', 'org-beta'],
          verifyAuth0Token: verify,
        });
        return listen(handler);
      };

      let base = await openApp();
      await new PostgresKnowledgeStore(pool!, 'org-alpha', false).upsertDocument(
        knowledgeDocument('alpha-doc', 'Alpha private guide')
      );
      await new PostgresKnowledgeStore(pool!, 'org-beta', false).upsertDocument(
        knowledgeDocument('beta-doc', 'Beta private guide')
      );

      const auth = (token: string) => ({
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      });
      const alphaList = await fetch(`${base}/api/v1/knowledge/documents`, {
        headers: auth(alphaRead),
      });
      const betaList = await fetch(`${base}/api/v1/knowledge/documents`, {
        headers: auth(betaRead),
      });
      const alphaBody = (await alphaList.json()) as { data: KnowledgeDocument[] };
      const betaBody = (await betaList.json()) as { data: KnowledgeDocument[] };
      expect(alphaBody.data.map((doc) => doc.id)).toEqual(['alpha-doc']);
      expect(betaBody.data.map((doc) => doc.id)).toEqual(['beta-doc']);

      const updated = await fetch(`${base}/api/v1/knowledge/documents/alpha-doc`, {
        method: 'PUT',
        headers: auth(alphaWrite),
        body: JSON.stringify({ title: 'Alpha updated guide' }),
      });
      expect(updated.status).toBe(200);
      expect(
        (await fetch(`${base}/api/v1/knowledge/documents/alpha-doc`, { headers: auth(betaRead) }))
          .status
      ).toBe(404);

      await stopServer();
      for (const retriever of tenantRetrievers) retriever.close();
      tenantRetrievers = [];
      await pool!.end();
      pool = undefined;
      base = await openApp();
      const afterRestart = await fetch(`${base}/api/v1/knowledge/documents/alpha-doc`, {
        headers: auth(alphaRead),
      });
      expect(afterRestart.status).toBe(200);
      const restartedBody = (await afterRestart.json()) as { data: KnowledgeDocument };
      expect(restartedBody.data.title).toBe('Alpha updated guide');
      expect(
        await fetch(`${base}/api/v1/knowledge/documents/alpha-doc`, { headers: auth(betaRead) })
      ).toHaveProperty('status', 404);
    }
  );
});
