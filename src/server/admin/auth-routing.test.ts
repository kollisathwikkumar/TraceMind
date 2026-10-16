import { describe, expect, it } from 'vitest';
import { safeAuthReturnTarget } from './auth-routing';

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
