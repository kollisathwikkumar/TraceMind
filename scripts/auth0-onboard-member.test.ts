import { describe, expect, it, vi } from 'vitest';
import { onboardOrganizationMember, type OnboardingOptions } from './auth0-onboard-member.js';

const options: OnboardingOptions = {
  organizationId: 'org_TraceMind1234',
  userId: 'google-oauth2|123456789',
  apply: false,
};

const environment = {
  AUTH0_DOMAIN: 'dev.example.auth0.com',
  AUTH0_MGMT_CLIENT_ID: 'management-client-id',
  AUTH0_MGMT_CLIENT_SECRET: 'do-not-log-this-secret',
  AUTH0_AUDIENCE: 'https://api.tracemind.example',
  AUTH0_BASELINE_READONLY_ROLE_ID: 'rol_TraceMindReadOnly1',
  TRACEMIND_ORG_IDS: 'org_TraceMind1234,org_OtherTenant99',
} as NodeJS.ProcessEnv;

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

function managementFetch(optionsFor: { member?: boolean; roleAssigned?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const state = {
    member: Boolean(optionsFor.member),
    roleAssigned: Boolean(optionsFor.roleAssigned),
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    if (url.endsWith('/oauth/token')) return response({ access_token: 'private-access-token' });
    if (url.endsWith('/api/v2/users/google-oauth2%7C123456789'))
      return response({ user_id: options.userId });
    if (url.endsWith('/api/v2/organizations/org_TraceMind1234'))
      return response({ id: options.organizationId });
    if (url.endsWith('/api/v2/roles/rol_TraceMindReadOnly1')) {
      return response({ id: 'rol_TraceMindReadOnly1', name: 'TraceMind Read-only' });
    }
    if (url.includes('/api/v2/roles/rol_TraceMindReadOnly1/permissions')) {
      return response([
        {
          resource_server_identifier: environment.AUTH0_AUDIENCE,
          permission_name: 'incidents:read',
        },
        {
          resource_server_identifier: environment.AUTH0_AUDIENCE,
          permission_name: 'knowledge:read',
        },
        {
          resource_server_identifier: environment.AUTH0_AUDIENCE,
          permission_name: 'graph:read',
        },
      ]);
    }
    if (
      url.includes(
        '/api/v2/organizations/org_TraceMind1234/members/google-oauth2%7C123456789/roles'
      )
    ) {
      if (method === 'POST') {
        state.roleAssigned = true;
        return response(undefined, 204);
      }
      if (!state.member) return response({ error: 'member missing' }, 404);
      return response(state.roleAssigned ? [{ id: 'rol_TraceMindReadOnly1' }] : []);
    }
    if (url.endsWith('/api/v2/organizations/org_TraceMind1234/members') && method === 'POST') {
      state.member = true;
      return response(undefined, 204);
    }
    return response({ error: 'unexpected request' }, 500);
  }) as unknown as typeof fetch;
  return { fetchMock, calls };
}

describe('Auth0 organization member onboarding', () => {
  it('dry-runs safely and validates the configured role before reporting the exact changes', async () => {
    const { fetchMock, calls } = managementFetch();
    const result = await onboardOrganizationMember(options, environment, fetchMock);

    expect(result).toMatchObject({
      memberAlreadyPresent: false,
      roleAlreadyAssigned: false,
      changes: ['add user to organization', 'assign TraceMind Read-only organization role'],
      applied: false,
    });
    expect(calls.every((call) => call.method === 'GET' || call.url.endsWith('/oauth/token'))).toBe(
      true
    );
    expect(JSON.stringify(result)).not.toContain(environment.AUTH0_MGMT_CLIENT_SECRET);
  });

  it('requires an allowlisted organization before requesting a Management API token', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    await expect(
      onboardOrganizationMember(
        { ...options, organizationId: 'org_Unapproved123' },
        environment,
        fetchMock
      )
    ).rejects.toThrow('not in the TraceMind organization allowlist');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies membership before assigning the read-only role when --apply is selected', async () => {
    const { fetchMock, calls } = managementFetch();
    await onboardOrganizationMember({ ...options, apply: true }, environment, fetchMock);

    expect(
      calls
        .filter((call) => call.method === 'POST' && call.url.includes('/api/v2/'))
        .map((call) => call.url)
    ).toEqual([
      'https://dev.example.auth0.com/api/v2/organizations/org_TraceMind1234/members',
      'https://dev.example.auth0.com/api/v2/organizations/org_TraceMind1234/members/google-oauth2%7C123456789/roles',
    ]);
    expect(
      calls.find((call) => call.url.endsWith('/members') && call.method === 'POST')?.body
    ).toBe(JSON.stringify({ members: [options.userId] }));
    expect(calls.find((call) => call.url.endsWith('/roles') && call.method === 'POST')?.body).toBe(
      JSON.stringify({ roles: ['rol_TraceMindReadOnly1'] })
    );
  });

  it('is idempotent when the member and target organization role already exist', async () => {
    const { fetchMock, calls } = managementFetch({ member: true, roleAssigned: true });
    const result = await onboardOrganizationMember(
      { ...options, apply: true },
      environment,
      fetchMock
    );

    expect(result.changes).toEqual([]);
    expect(calls.some((call) => call.method === 'POST' && call.url.includes('/api/v2/'))).toBe(
      false
    );
  });

  it('rejects a role containing any permission outside the exact read-only set', async () => {
    const { fetchMock } = managementFetch();
    const unsafeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/roles/rol_TraceMindReadOnly1/permissions')) {
        return response([
          {
            resource_server_identifier: environment.AUTH0_AUDIENCE,
            permission_name: 'incidents:write',
          },
        ]);
      }
      return fetchMock(input, init);
    }) as unknown as typeof fetch;

    await expect(
      onboardOrganizationMember({ ...options, apply: true }, environment, unsafeFetch)
    ).rejects.toThrow('approved read-only permission set');
  });

  it('requests only the onboarding Management API scopes', async () => {
    const { fetchMock, calls } = managementFetch();
    await onboardOrganizationMember(options, environment, fetchMock);
    const tokenRequest = calls.find((call) => call.url.endsWith('/oauth/token'));
    expect(tokenRequest?.body).toContain(
      '"scope":"read:users read:organizations read:roles read:organization_member_roles create:organization_members create:organization_member_roles"'
    );
  });

  it('reads subsequent permission pages and rejects write scopes beyond the first page', async () => {
    const { fetchMock } = managementFetch();
    const paginatedFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/roles/rol_TraceMindReadOnly1/permissions?')) {
        const page = Number(new URL(url).searchParams.get('page'));
        if (page === 0) {
          return response(
            Array.from({ length: 100 }, () => ({
              resource_server_identifier: environment.AUTH0_AUDIENCE,
              permission_name: 'incidents:read',
            }))
          );
        }
        if (page === 1) {
          return response([
            {
              resource_server_identifier: environment.AUTH0_AUDIENCE,
              permission_name: 'incidents:write',
            },
          ]);
        }
      }
      return fetchMock(input, init);
    }) as unknown as typeof fetch;
    await expect(onboardOrganizationMember(options, environment, paginatedFetch)).rejects.toThrow(
      'approved read-only permission set'
    );
  });
});
