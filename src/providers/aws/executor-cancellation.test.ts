import { describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('./client', () => ({
  getClient: vi.fn(
    async (ClientClass: new (config: { region: string }) => unknown) =>
      new ClientClass({ region: 'test-region' })
  ),
}));
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class {
    send(...args: unknown[]) {
      return send(...args);
    }
  },
  DescribeInstancesCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { executeListOperation } from './executor';

describe('dynamic AWS executor cancellation', () => {
  it('forwards AbortSignal to each AWS SDK v3 paged send', async () => {
    const signal = new AbortController().signal;
    send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: 'i-test', State: { Name: 'running' } }] }],
    });
    const service = {
      id: 'ec2',
      name: 'EC2',
      description: 'test',
      category: 'compute' as const,
      sdkPackage: '@aws-sdk/client-ec2',
      clientClass: 'EC2Client',
      listOperation: {
        name: 'describe instances',
        description: 'list instances',
        command: 'DescribeInstancesCommand',
        params: {},
        resultPath: 'Reservations',
      },
      resourceFormatter: { idField: 'Instances.0.InstanceId' },
    };

    await executeListOperation(service, { region: 'test-region', signal });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
  });
});
