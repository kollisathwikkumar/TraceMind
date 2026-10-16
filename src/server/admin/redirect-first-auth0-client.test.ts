import { describe, expect, it, vi } from 'vitest';
import { RedirectFirstAuth0Client } from './redirect-first-auth0-client';

describe('RedirectFirstAuth0Client', () => {
  it('skips the startup iframe session check and leaves login to Universal Login', async () => {
    const client = new RedirectFirstAuth0Client({ domain: 'tenant.example', clientId: 'client' });
    const getTokenSilently = vi.spyOn(client, 'getTokenSilently');

    await expect(client.checkSession()).resolves.toBeUndefined();
    expect(getTokenSilently).not.toHaveBeenCalled();
    expect(await client.getUser()).toBeUndefined();
  });
});
