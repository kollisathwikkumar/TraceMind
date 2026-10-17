import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAuth0TokenVerifier, resolveAuth0Config } from './auth0';

describe('Auth0 configuration and access-token verification', () => {
  it('requires complete configuration and normalizes the tenant issuer', () => {
    expect(resolveAuth0Config({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(() =>
      resolveAuth0Config({ AUTH0_DOMAIN: 'tenant.example.auth0.com' } as NodeJS.ProcessEnv)
    ).toThrow(/requires/);
    expect(
      resolveAuth0Config({
        AUTH0_DOMAIN: 'https://Tenant.Example.auth0.com/',
        AUTH0_CLIENT_ID: 'client',
        AUTH0_AUDIENCE: 'https://api.example.test',
      } as NodeJS.ProcessEnv)
    ).toEqual({
      domain: 'tenant.example.auth0.com',
      clientId: 'client',
      audience: 'https://api.example.test',
      issuer: 'https://tenant.example.auth0.com/',
    });
  });

  it('accepts correctly signed audience and issuer tokens and rejects tampering/invalid claims', async () => {
    const config = {
      domain: 'tenant.example.auth0.com',
      clientId: 'client',
      audience: 'https://api.example.test',
      issuer: 'https://tenant.example.auth0.com/',
    };
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = await exportJWK(publicKey);
    const verify = createAuth0TokenVerifier(
      config,
      createLocalJWKSet({ keys: [{ ...publicJwk, kid: 'key-1', alg: 'RS256', use: 'sig' }] })
    );
    const token = await new SignJWT({ email: 'alice@example.test' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('auth0|alice')
      .setExpirationTime('2m')
      .sign(privateKey);
    const tokenWithAccess = await new SignJWT({
      email: 'alice@example.test',
      scope: 'incidents:read graph:read',
      permissions: ['remediations:approve'],
      roles: ['operator'],
      org_id: 'org-a',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject('auth0|alice')
      .setExpirationTime('2m')
      .sign(privateKey);
    expect(await verify(tokenWithAccess)).toEqual({
      sub: 'auth0|alice',
      email: 'alice@example.test',
      scopes: ['incidents:read', 'graph:read', 'remediations:approve'],
      roles: ['operator'],
      organizationId: 'org-a',
    });
    const [header, payload, signature] = token.split('.');
    const tampered = `${header}.${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    expect(await verify(tampered)).toBeUndefined();
    const wrongAudience = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(config.issuer)
      .setAudience('https://wrong.example.test')
      .setSubject('auth0|alice')
      .setExpirationTime('2m')
      .sign(privateKey);
    expect(await verify(wrongAudience)).toBeUndefined();
  });
});
