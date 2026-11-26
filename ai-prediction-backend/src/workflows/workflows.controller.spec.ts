import { ConflictException } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';

describe('WorkflowsController manual notification idempotency', () => {
  const gateway = { emitNotificationNew: jest.fn() };
  const demo = {
    status: jest.fn().mockResolvedValue({ generationEnabled: false, disclaimer: 'DEMO / SYNTHETIC' }),
    generateDemoPredictions: jest.fn(),
    demoSummary: jest.fn(),
  };

  beforeEach(() => {
    gateway.emitNotificationNew.mockReset();
  });

  it('keeps prediction generation disabled and never persists synthetic ML output', async () => {
    const prisma = {};
    const email = { dispatch: jest.fn(), retry: jest.fn() };
    const ml = {
      probe: jest.fn().mockResolvedValue({
        reachable: true,
        ready: { status: 'ready', modelAvailable: true, operatingMode: 'synthetic_demo', isSynthetic: true, disclaimer: 'Synthetic demo mode only.' },
      }),
    };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never, gateway as never, demo as never);
    await expect(controller.generate()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PREDICTION_GENERATION_DISABLED' }),
    });
    expect(ml.probe).toHaveBeenCalled();
  });

  it('returns a persisted notification for a repeated key without dispatching email again or emitting realtime', async () => {
    const existing = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Existing manual message',
      emailDelivery: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'SMTP_ACCEPTED', attemptCount: 1 },
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(existing), create: jest.fn() },
    };
    const email = { dispatch: jest.fn(), retry: jest.fn() };
    const ml = { probe: jest.fn(), getReadyStatus: jest.fn(), predict: jest.fn() };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never, gateway as never, demo as never);
    const result = await controller.createNotification({ recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Duplicate', message: 'Duplicate' }, 'same-manual-event-key');
    expect(result.data.notification).toBe(existing);
    expect(result.data.duplicate).toBe(true);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(email.dispatch).not.toHaveBeenCalled();
    expect(gateway.emitNotificationNew).not.toHaveBeenCalled();
  });

  it('emits notification:new only after a successful create transaction commit', async () => {
    const created = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Manual notice',
      message: 'Hello',
      alertId: null,
      inAppVisible: true,
      readAt: null,
      createdAt: new Date('2026-11-23T06:00:00.000Z'),
      emailDelivery: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'PENDING' },
    };
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
        user: { findUnique: jest.fn().mockResolvedValue({ id: created.recipientId, status: 'ACTIVE', preference: { inApp: true, email: false } }) },
        notification: { create: jest.fn().mockResolvedValue(created) },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
      })),
    };
    const email = { dispatch: jest.fn().mockResolvedValue({ status: 'SKIPPED_DISABLED' }), retry: jest.fn() };
    const ml = { probe: jest.fn() };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never, gateway as never, demo as never);
    await controller.createNotification({ recipientId: created.recipientId, title: 'Manual notice', message: 'Hello' }, 'unique-manual-event-key');
    expect(gateway.emitNotificationNew).toHaveBeenCalledTimes(1);
    expect(gateway.emitNotificationNew).toHaveBeenCalledWith(created.recipientId, expect.objectContaining({
      id: created.id,
      type: 'manual',
      title: 'Manual notice',
      message: 'Hello',
      readAt: null,
    }));
    expect(email.dispatch).toHaveBeenCalledWith(created.id);
  });

  it('does not emit realtime events when persistence fails before commit', async () => {
    const prisma = {
      notification: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async () => {
        throw new Error('forced persistence failure');
      }),
    };
    const email = { dispatch: jest.fn(), retry: jest.fn() };
    const ml = { probe: jest.fn() };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never, gateway as never, demo as never);
    await expect(controller.createNotification({ recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Manual notice', message: 'Hello' }, 'failing-manual-event-key')).rejects.toThrow('forced persistence failure');
    expect(gateway.emitNotificationNew).not.toHaveBeenCalled();
    expect(email.dispatch).not.toHaveBeenCalled();
  });

  it('does not allow the manual-message retry route to send email for a risk alert', async () => {
    const prisma = { notification: { findUnique: jest.fn().mockResolvedValue({ id: 'notification', alertId: 'alert-id' }) } };
    const email = { dispatch: jest.fn(), retry: jest.fn().mockRejectedValue(new ConflictException('Automated alert email is not enabled')) };
    const ml = { probe: jest.fn(), getReadyStatus: jest.fn(), predict: jest.fn() };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never, gateway as never, demo as never);
    await expect(controller.retryNotificationEmail('notification')).rejects.toBeInstanceOf(ConflictException);
    expect(email.retry).toHaveBeenCalledWith('notification');
  });
});
