import { describe, expect, it } from 'vitest';
import { dashboardTokenError } from './auth-errors.js';

describe('dashboard Auth0 token errors', () => {
  it.each([
    ['consent_required', /consent configuration/],
    ['login_required', /sign out and sign in again/i],
    ['interaction_required', /sign out and sign in again/i],
    ['invalid_scope', /organization role/],
    ['access_denied', /organization role/],
    ['missing_refresh_token', /session expired/],
    ['invalid_grant', /session expired/],
  ])('provides actionable guidance for %s', (code, expected) => {
    const error = dashboardTokenError({ error: code, message: 'private provider details' });
    expect(error.message).toMatch(expected);
    expect(error.message).not.toContain('private provider details');
  });
});
