import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface Auth0Config {
  domain: string;
  clientId: string;
  audience: string;
  issuer: string;
}

export interface Auth0Identity {
  sub: string;
  email?: string;
  scopes: string[];
  roles: string[];
  organizationId?: string;
}

export function resolveAuth0Config(
  environment: NodeJS.ProcessEnv = process.env
): Auth0Config | undefined {
  const domainInput = environment.AUTH0_DOMAIN?.trim();
  const clientId = environment.AUTH0_CLIENT_ID?.trim();
  const audience = environment.AUTH0_AUDIENCE?.trim();
  if (!domainInput && !clientId && !audience) return undefined;
  if (!domainInput || !clientId || !audience) {
    throw new Error('Auth0 requires AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_AUDIENCE');
  }

  const domainUrl = new URL(domainInput.includes('://') ? domainInput : `https://${domainInput}`);
  if (
    domainUrl.protocol !== 'https:' ||
    domainUrl.pathname !== '/' ||
    domainUrl.search ||
    domainUrl.hash
  ) {
    throw new Error('AUTH0_DOMAIN must be an HTTPS Auth0 domain without a path');
  }
  const domain = domainUrl.host.toLowerCase();
  return { domain, clientId, audience, issuer: `https://${domain}/` };
}

export function createAuth0TokenVerifier(
  config: Auth0Config,
  keySet: JWTVerifyGetKey = createRemoteJWKSet(new URL('.well-known/jwks.json', config.issuer))
): (token: string) => Promise<Auth0Identity | undefined> {
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
      });
      return identityFromPayload(payload);
    } catch {
      return undefined;
    }
  };
}

function identityFromPayload(payload: JWTPayload): Auth0Identity | undefined {
  if (typeof payload.sub !== 'string' || !payload.sub) return undefined;
  return {
    sub: payload.sub,
    ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
    scopes: [
      ...(typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : []),
      ...(Array.isArray(payload.permissions)
        ? payload.permissions.filter((value): value is string => typeof value === 'string')
        : []),
    ],
    roles: Array.isArray(payload.roles)
      ? payload.roles.filter((value): value is string => typeof value === 'string')
      : [],
    ...(typeof payload.org_id === 'string' && payload.org_id
      ? { organizationId: payload.org_id }
      : {}),
  };
}
