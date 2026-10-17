import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_AUTHORIZATION_SCOPE,
  authReturnToWithoutInvitation,
  organizationLoginAuthorizationParams,
  safeAuthReturnTarget,
} from './auth-routing';

describe('safeAuthReturnTarget', () => {
  it('preserves an in-app dashboard route without a full-page redirect', () => {
    expect(safeAuthReturnTarget('/admin#/graph', 'https://tracemind.example')).toBe(
      '/admin#/graph'
    );
  });

  it('rejects external and non-dashboard redirect targets', () => {
    expect(
      safeAuthReturnTarget('https://attacker.example/admin', 'https://tracemind.example')
    ).toBeUndefined();
    expect(safeAuthReturnTarget('/admin-evil', 'https://tracemind.example')).toBeUndefined();
    expect(safeAuthReturnTarget('/settings', 'https://tracemind.example')).toBeUndefined();
  });
});

describe('organizationLoginAuthorizationParams', () => {
  it('extracts and forwards a valid organization invitation', () => {
    const forwardedAuthorizationParams = organizationLoginAuthorizationParams(
      'org_tracemind',
      '?invitation=invite-token&organization=org_tracemind'
    );

    expect(forwardedAuthorizationParams).toEqual({
      organization: 'org_tracemind',
      invitation: 'invite-token',
      scope: DASHBOARD_AUTHORIZATION_SCOPE,
    });
  });

  it('rejects an invitation that names a different organization', () => {
    expect(
      organizationLoginAuthorizationParams(
        'org_tracemind',
        '?invitation=invite-token&organization=org_other'
      )
    ).toBeNull();
  });

  it('rejects incomplete invitation parameters and ignores unrelated query values', () => {
    expect(
      organizationLoginAuthorizationParams('org_tracemind', '?invitation=invite-token')
    ).toBeNull();
    expect(
      organizationLoginAuthorizationParams('org_tracemind', '?organization=org_other')
    ).toBeNull();
    expect(organizationLoginAuthorizationParams('org_tracemind', '?campaign=invite-token')).toEqual(
      {
        organization: 'org_tracemind',
        scope: DASHBOARD_AUTHORIZATION_SCOPE,
      }
    );
  });

  it('requests the read permissions the initial dashboard needs without requesting write access', () => {
    const authorizationParams = organizationLoginAuthorizationParams('org_tracemind', '');

    expect(authorizationParams?.scope.split(' ')).toEqual([
      'openid',
      'profile',
      'email',
      'incidents:read',
      'knowledge:read',
      'graph:read',
      'remediations:read',
      'evaluations:read',
      'llm:validate',
    ]);
    expect(authorizationParams?.scope).not.toContain(':write');
  });
});

describe('authReturnToWithoutInvitation', () => {
  it('removes invitation credentials and organization routing from the return URL', () => {
    expect(
      authReturnToWithoutInvitation({
        pathname: '/admin',
        search: '?invitation=invite-token&organization=org_tracemind&view=incidents',
        hash: '#/incidents',
      })
    ).toBe('/admin?view=incidents#/incidents');
  });
});
