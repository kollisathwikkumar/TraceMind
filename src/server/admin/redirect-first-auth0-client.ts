import { Auth0Client } from '@auth0/auth0-spa-js';

/**
 * Prefer top-level Universal Login to the startup silent-session iframe.
 * That iframe can stall on browsers that restrict third-party cookies; the
 * top-level redirect still reuses an existing Auth0 SSO session without
 * forcing users to enter their credentials again.
 */
export class RedirectFirstAuth0Client extends Auth0Client {
  override async checkSession(): Promise<void> {
    // Auth0Provider calls checkSession during startup. Auth0LoginScreen then
    // starts the regular PKCE redirect, avoiding a slow silent iframe check.
  }
}
