import { ConflictException } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';

describe('WorkflowsController manual notification idempotency', () => {
  it('keeps prediction generation disabled and never persists synthetic ML output', async () => {
    const prisma = {};
    const email = { dispatch: jest.fn(), retry: jest.fn() };
    const ml = {
      probe: jest.fn().mockResolvedValue({
        reachable: true,
        ready: { status: 'ready', modelAvailable: true, operatingMode: 'synthetic_demo', isSynthetic: true, disclaimer: 'Synthetic demo mode only.' },
      }),
    };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never);
    await expect(controller.generate()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PREDICTION_GENERATION_DISABLED' }),
    });
    expect(ml.probe).toHaveBeenCalled();
  });

  it('returns a persisted notification for a repeated key without dispatching email again', async () => {
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
    const controller = new WorkflowsController(prisma as never, email as never, ml as never);
    const result = await controller.createNotification({ recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Duplicate', message: 'Duplicate' }, 'same-manual-event-key');
    expect(result.data.notification).toBe(existing);
    expect(result.data.duplicate).toBe(true);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(email.dispatch).not.toHaveBeenCalled();
  });

  it('does not allow the manual-message retry route to send email for a risk alert', async () => {
    const prisma = { notification: { findUnique: jest.fn().mockResolvedValue({ id: 'notification', alertId: 'alert-id' }) } };
    const email = { dispatch: jest.fn(), retry: jest.fn().mockRejectedValue(new ConflictException('Automated alert email is not enabled')) };
    const ml = { probe: jest.fn(), getReadyStatus: jest.fn(), predict: jest.fn() };
    const controller = new WorkflowsController(prisma as never, email as never, ml as never);
    await expect(controller.retryNotificationEmail('notification')).rejects.toBeInstanceOf(ConflictException);
    expect(email.retry).toHaveBeenCalledWith('notification');
  });
});
