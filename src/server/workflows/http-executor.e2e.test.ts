import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpRemediationExecutor } from './http-executor';
import { RemediationWorkflow } from './remediation';
import { WorkflowStore } from './store';

interface BrokerRequest {
  path: string;
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  body: {
    identifier: string;
    incidentId: string;
    planId: string;
    stepId: string;
  };
}

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
  directories.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true })
  );
});

describe('HTTP remediation executor end to end', () => {
  it('persists an approval-separated execute, verification, and rollback flow through a real broker', async () => {
    const brokerRequests: BrokerRequest[] = [];
    const broker = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrokerRequest['body'];
      const idempotencyHeader = request.headers['idempotency-key'];
      brokerRequests.push({
        path: request.url || '',
        authorization: request.headers.authorization,
        idempotencyKey: Array.isArray(idempotencyHeader)
          ? idempotencyHeader[0]
          : idempotencyHeader,
        body,
      });

      response.writeHead(200, { 'Content-Type': 'application/json' });
      if (request.url === '/checks/verify') {
        response.end(JSON.stringify({ succeeded: true, evidence: 'service health check passed' }));
      } else if (request.url === '/actions/rollback') {
        response.end(JSON.stringify({ succeeded: true, output: 'previous release restored' }));
      } else {
        response.end(JSON.stringify({ succeeded: true, output: 'service restarted' }));
      }
    });
    servers.push(broker);
    await new Promise<void>((resolve, reject) => {
      broker.once('error', reject);
      broker.listen(0, '127.0.0.1', () => resolve());
    });
    const address = broker.address();
    if (!address || typeof address === 'string') throw new Error('Ephemeral broker did not bind');

    const directory = mkdtempSync(join(tmpdir(), 'tracemind-http-remediation-e2e-'));
    directories.push(directory);
    const databasePath = join(directory, 'workflows.sqlite');
    let store = new WorkflowStore(databasePath);
    const executor = new HttpRemediationExecutor(
      `http://127.0.0.1:${address.port}`,
      'broker-service-token',
      fetch,
      5_000,
      {
        actionIds: ['service.restart'],
        checkIds: ['service.health'],
        rollbackActionIds: ['service.restore'],
        allowedOrigins: [`http://127.0.0.1:${address.port}`],
      }
    );
    const workflow = new RemediationWorkflow(store, executor);
    const plan = store.createPlan(
      'incident-http-e2e',
      'Restart and verify service',
      [
        {
          actionId: 'service.restart',
          postCheckId: 'service.health',
          rollbackActionId: 'service.restore',
          description: 'Restart the registered service target',
        },
      ],
      'proposer'
    );
    const stepId = plan.steps[0].id;

    expect(() =>
      store.decide(plan.id, stepId, 'approve', 'proposer', 'self approval')
    ).toThrow('proposer cannot approve');
    store.decide(plan.id, stepId, 'approve', 'approver', 'Reviewed impact and rollback');
    await expect(workflow.execute(plan.id, stepId, 'approver')).rejects.toThrow(
      'approver and executor must be different'
    );

    await expect(workflow.execute(plan.id, stepId, 'executor')).resolves.toMatchObject({
      executionSucceeded: true,
      verificationSucceeded: true,
      status: 'verified',
      execution: { succeeded: true, output: 'service restarted' },
      verification: { succeeded: true, evidence: 'service health check passed' },
    });

    const executionKey = `${plan.id}:${stepId}:execute`;
    expect(brokerRequests.slice(0, 2)).toEqual([
      expect.objectContaining({
        path: '/actions/execute',
        authorization: 'Bearer broker-service-token',
        idempotencyKey: executionKey,
        body: {
          identifier: 'service.restart',
          incidentId: 'incident-http-e2e',
          planId: plan.id,
          stepId,
        },
      }),
      expect.objectContaining({
        path: '/checks/verify',
        authorization: 'Bearer broker-service-token',
        idempotencyKey: executionKey,
        body: {
          identifier: 'service.health',
          incidentId: 'incident-http-e2e',
          planId: plan.id,
          stepId,
        },
      }),
    ]);

    expect(() =>
      store.decideRollback(plan.id, stepId, 'approve', 'executor', 'self approval')
    ).toThrow('Rollback proposer, approver, executor, and verification reconciler must be different');
    store.decideRollback(
      plan.id,
      stepId,
      'approve',
      'rollback-approver',
      'Verification window requires restoration'
    );
    await expect(workflow.rollback(plan.id, stepId, 'rollback-executor')).resolves.toMatchObject({
      status: 'rolled_back',
      result: { succeeded: true, output: 'previous release restored' },
    });

    expect(brokerRequests[2]).toEqual(
      expect.objectContaining({
        path: '/actions/rollback',
        authorization: 'Bearer broker-service-token',
        idempotencyKey: `${plan.id}:${stepId}:rollback`,
        body: {
          identifier: 'service.restore',
          incidentId: 'incident-http-e2e',
          planId: plan.id,
          stepId,
        },
      })
    );

    store.close();
    store = new WorkflowStore(databasePath);
    expect(store.getPlan(plan.id)?.steps[0]).toMatchObject({
      status: 'rolled_back',
      approvedBy: 'approver',
      executedBy: 'executor',
      executionResult: { succeeded: true, output: 'service restarted' },
      verificationResult: { succeeded: true, evidence: 'service health check passed' },
      rollbackResult: { succeeded: true, output: 'previous release restored' },
    });
    expect(store.events(plan.id).map(({ action, actor }) => ({ action, actor }))).toEqual([
      { action: 'proposed', actor: 'proposer' },
      { action: 'approved', actor: 'approver' },
      { action: 'execution_started', actor: 'executor' },
      { action: 'executed', actor: 'executor' },
      { action: 'post_check_passed', actor: 'executor' },
      { action: 'rollback_approved', actor: 'rollback-approver' },
      { action: 'rollback_started', actor: 'rollback-executor' },
      { action: 'rolled_back', actor: 'rollback-executor' },
    ]);
    store.close();
  });
});
