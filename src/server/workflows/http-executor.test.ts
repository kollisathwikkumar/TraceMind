import { describe, expect, it, vi } from 'vitest';
import {
  createConfiguredRemediationExecutor,
  HttpRemediationExecutor,
  isRemediationExecutorRequired,
  resolveRemediationExecutor,
  type ExecutorFetch,
} from './http-executor';

const context = {
  incidentId: 'incident-1',
  planId: 'plan-1',
  stepId: 'step-1',
  idempotencyKey: 'plan-1:step-1:execute',
};
const registry = {
  actionIds: ['service.restart'],
  checkIds: ['service.healthy'],
  rollbackActionIds: ['service.restore'],
  allowedOrigins: ['https://broker.example'],
};

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpRemediationExecutor', () => {
  it('sends only allowlisted identifiers with bearer auth and a stable idempotency key', async () => {
    const fetcher = vi.fn<ExecutorFetch>().mockResolvedValue(response({ succeeded: true, output: 'done' }));
    const executor = new HttpRemediationExecutor(
      'https://broker.example/api/',
      'broker-token',
      fetcher,
      1000,
      registry
    );

    await expect(executor.execute('service.restart', context)).resolves.toEqual({
      succeeded: true,
      output: 'done',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url.href).toBe('https://broker.example/api/actions/execute');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer broker-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': context.idempotencyKey,
    });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({
      identifier: 'service.restart',
      incidentId: context.incidentId,
      planId: context.planId,
      stepId: context.stepId,
    });
    expect(() => executor.execute('unregistered.command', context)).toThrow(/allowlist/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid responses and non-success HTTP statuses', async () => {
    const invalid = new HttpRemediationExecutor(
      'https://broker.example',
      'token',
      vi.fn<ExecutorFetch>().mockResolvedValue(response({ succeeded: 'yes' })),
      1000,
      registry
    );
    await expect(invalid.verify('service.healthy', context)).rejects.toThrow(/invalid result/);

    const failedStatus = new HttpRemediationExecutor(
      'https://broker.example',
      'token',
      vi.fn<ExecutorFetch>().mockResolvedValue(response({ succeeded: true }, 503)),
      1000,
      registry
    );
    await expect(failedStatus.rollback('service.restore', context)).rejects.toThrow(/HTTP 503/);
  });

  it('rejects unsafe endpoint URLs and malformed idempotency keys', async () => {
    expect(
      () =>
        new HttpRemediationExecutor(
          'https://user:password@broker.example',
          'token',
          fetch,
          1000,
          registry
        )
    ).toThrow(/must not include credentials/);
    expect(
      () => new HttpRemediationExecutor('https://private.internal', 'token', fetch, 1000, registry)
    ).toThrow(/origin is not in the configured origin allowlist/);
    expect(
      () =>
        new HttpRemediationExecutor('http://broker.example', 'token', fetch, 1000, registry)
    ).toThrow(/must use HTTPS/);
    const fetcher = vi.fn<ExecutorFetch>().mockResolvedValue(response({ succeeded: true }));
    const executor = new HttpRemediationExecutor(
      'https://broker.example',
      'token',
      fetcher,
      1000,
      registry
    );
    await expect(
      executor.execute('service.restart', { ...context, idempotencyKey: 'bad\r\nkey' })
    ).rejects.toThrow(/idempotency key/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts broker requests after the configured timeout', async () => {
    const fetcher: ExecutorFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const executor = new HttpRemediationExecutor(
      'https://broker.example',
      'token',
      fetcher,
      5,
      registry
    );
    await expect(executor.execute('service.restart', context)).rejects.toThrow('aborted');
  });

  it('parses optional and required executor configuration fail-closed', () => {
    expect(createConfiguredRemediationExecutor({})).toBeUndefined();
    expect(isRemediationExecutorRequired({})).toBe(false);
    expect(isRemediationExecutorRequired({ TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED: ' true ' })).toBe(
      true
    );
    expect(() => isRemediationExecutorRequired({ TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED: 'yes' })).toThrow(
      /must be true or false/
    );
    expect(() =>
      resolveRemediationExecutor(undefined, { TRACEMIND_REMEDIATION_EXECUTOR_REQUIRED: 'true' })
    ).toThrow(/no remediation executor is configured/);
    expect(() =>
      createConfiguredRemediationExecutor({
        TRACEMIND_REMEDIATION_EXECUTOR_URL: 'https://broker.example',
      })
    ).toThrow(/configured together/);
    expect(() =>
      createConfiguredRemediationExecutor({
        TRACEMIND_REMEDIATION_EXECUTOR_URL: 'https://broker.example',
        TRACEMIND_REMEDIATION_EXECUTOR_TOKEN: 'token',
        TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS: 'https://broker.example',
      })
    ).toThrow(/allowlists/);
    expect(() =>
      createConfiguredRemediationExecutor({
        TRACEMIND_REMEDIATION_EXECUTOR_URL: 'https://broker.example',
        TRACEMIND_REMEDIATION_EXECUTOR_TOKEN: 'token',
        TRACEMIND_REMEDIATION_ACTION_IDS: 'valid,not valid',
        TRACEMIND_REMEDIATION_CHECK_IDS: 'service.healthy',
        TRACEMIND_REMEDIATION_ROLLBACK_IDS: 'service.restore',
        TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS: 'https://broker.example',
      })
    ).toThrow(/invalid identifier/);
    expect(() =>
      createConfiguredRemediationExecutor({
        TRACEMIND_REMEDIATION_EXECUTOR_URL: 'https://broker.example',
        TRACEMIND_REMEDIATION_EXECUTOR_TOKEN: 'token',
        TRACEMIND_REMEDIATION_ACTION_IDS: 'service.restart',
        TRACEMIND_REMEDIATION_CHECK_IDS: 'service.healthy',
        TRACEMIND_REMEDIATION_ROLLBACK_IDS: 'service.restore',
        TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS: 'https://other.example',
      })
    ).toThrow(/origin is not in the configured origin allowlist/);

    expect(
      createConfiguredRemediationExecutor({
        TRACEMIND_REMEDIATION_EXECUTOR_URL: 'https://broker.example',
        TRACEMIND_REMEDIATION_EXECUTOR_TOKEN: 'token',
        TRACEMIND_REMEDIATION_ACTION_IDS: ' service.restart,service.restart ',
        TRACEMIND_REMEDIATION_CHECK_IDS: 'service.healthy',
        TRACEMIND_REMEDIATION_ROLLBACK_IDS: 'service.restore',
        TRACEMIND_REMEDIATION_EXECUTOR_ALLOWED_ORIGINS: 'https://broker.example',
      })
    ).toBeInstanceOf(HttpRemediationExecutor);
  });
});
