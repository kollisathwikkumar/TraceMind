import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send(...args: unknown[]) {
      return send(...args);
    }
  },
  DescribeAlarmsCommand: class {
    constructor(readonly input: unknown) {}
  },
  GetMetricStatisticsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));
vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    send(...args: unknown[]) {
      return send(...args);
    }
  },
  FilterLogEventsCommand: class {
    constructor(readonly input: unknown) {}
  },
  DescribeLogGroupsCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

import { getActiveAlarms } from './cloudwatch';

describe('CloudWatch request cancellation', () => {
  beforeEach(() => send.mockReset().mockResolvedValue({ MetricAlarms: [] }));

  it('forwards the investigation AbortSignal to the AWS SDK send options', async () => {
    const signal = new AbortController().signal;

    await expect(getActiveAlarms(undefined, signal)).resolves.toEqual([]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
  });
});
