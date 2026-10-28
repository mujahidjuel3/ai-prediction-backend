import { ConflictException } from '@nestjs/common';
import { WorkflowsController } from './workflows.controller';

describe('WorkflowsController manual notification idempotency', () => {
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
    const controller = new WorkflowsController(prisma as never, email as never);
    const result = await controller.createNotification({ recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Duplicate', message: 'Duplicate' }, 'same-manual-event-key');
    expect(result.data.notification).toBe(existing);
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(email.dispatch).not.toHaveBeenCalled();
  });

  it('does not allow the manual-message retry route to send email for a risk alert', async () => {
    const prisma = { notification: { findUnique: jest.fn().mockResolvedValue({ id: 'notification', alertId: 'alert-id' }) } };
    const email = { dispatch: jest.fn(), retry: jest.fn().mockRejectedValue(new ConflictException('Automated alert email is not enabled')) };
    const controller = new WorkflowsController(prisma as never, email as never);
    await expect(controller.retryNotificationEmail('notification')).rejects.toBeInstanceOf(ConflictException);
    expect(email.retry).toHaveBeenCalledWith('notification');
  });
});
