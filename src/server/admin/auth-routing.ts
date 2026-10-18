/** Return only same-origin dashboard paths, suitable for restoring Auth0 app state. */
export function safeAuthReturnTarget(
  returnTo: string | undefined,
  origin: string
): string | undefined {
  if (!returnTo) return undefined;
  try {
    const target = new URL(returnTo, origin);
    if (target.origin !== origin || !/^\/admin(?:\/|$)/.test(target.pathname)) return undefined;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}

/** Request identity at login; route permissions are acquired silently per API operation. */
export const DASHBOARD_AUTHORIZATION_SCOPE = 'openid profile email';

/**
 * Preserve Auth0 organization invitations while keeping the organization
 * selected by trusted server configuration authoritative.
 */
export function organizationLoginAuthorizationParams(
  configuredOrganizationId: string,
  search: string
): { organization: string; invitation?: string; scope: string } | null {
  const query = new URLSearchParams(search);
  const requestedOrganization = query.get('organization');
  const invitation = query.get('invitation');

  if (query.has('organization') && requestedOrganization !== configuredOrganizationId) return null;
  if (query.has('invitation') && (!invitation || !requestedOrganization)) return null;

  return invitation
    ? { organization: configuredOrganizationId, invitation, scope: DASHBOARD_AUTHORIZATION_SCOPE }
    : { organization: configuredOrganizationId, scope: DASHBOARD_AUTHORIZATION_SCOPE };
}

/** Avoid reusing an invitation token after Auth0 has accepted the invitation. */
export function authReturnToWithoutInvitation(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>
): string {
  const query = new URLSearchParams(location.search);
  query.delete('invitation');
  query.delete('organization');
  const serializedQuery = query.toString();
  return `${location.pathname}${serializedQuery ? `?${serializedQuery}` : ''}${location.hash}`;
}
