/** Convert Auth0 token-acquisition failures into dashboard guidance without leaking SDK details. */
export function dashboardTokenError(error: unknown): Error {
  const candidate =
    error !== null && typeof error === 'object'
      ? (error as { error?: unknown; code?: unknown })
      : undefined;
  const code =
    (typeof candidate?.error === 'string' && candidate.error) ||
    (typeof candidate?.code === 'string' && candidate.code) ||
    '';
  if (code === 'consent_required') {
    return new Error(
      'TraceMind could not obtain API access silently. Sign in again; if this continues, ask your administrator to review the Auth0 API consent configuration.'
    );
  }
  if (code === 'login_required' || code === 'interaction_required') {
    return new Error('Your TraceMind sign-in needs refreshing. Sign out and sign in again.');
  }
  if (code === 'invalid_scope' || code === 'access_denied') {
    return new Error(
      'Your TraceMind organization role does not grant the permission needed for this action. Ask your administrator to review your role, then sign out and back in.'
    );
  }
  if (code === 'missing_refresh_token' || code === 'invalid_grant') {
    return new Error('Your TraceMind session expired. Sign out and sign in again.');
  }
  return new Error('TraceMind could not obtain an API access token. Sign out and sign in again.');
}
