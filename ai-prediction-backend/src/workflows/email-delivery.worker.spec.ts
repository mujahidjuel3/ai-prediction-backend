import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus } from '@prisma/client';
import { EmailDeliveryWorker } from './email-delivery.worker';
import { NotificationEmailService } from './notification-email.service';

describe('EmailDeliveryWorker', () => {
  function setup(options: { autoRetry?: boolean } = {}) {
    const prisma = {
      notificationEmailDelivery: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const email = {
      dispatch: jest.fn().mockResolvedValue({ status: EmailDeliveryStatus.SMTP_ACCEPTED, attemptCount: 1, lastErrorCode: null }),
      recordDeliveryLog: jest.fn().mockResolvedValue(undefined),
    };
    const configValues: Record<string, unknown> = {
      EMAIL_WORKER_ENABLED: true,
      EMAIL_WORKER_INTERVAL_MS: 15_000,
      EMAIL_WORKER_BATCH_SIZE: 10,
      EMAIL_WORKER_AUTO_RETRY: options.autoRetry ?? false,
      EMAIL_STALE_SENDING_MS: 300_000,
      EMAIL_MAX_DISPATCH_ROUNDS: 2,
      EMAIL_RETRY_BACKOFF_MS: 60_000,
    };
    const config = { get: (key: string) => configValues[key] } as unknown as ConfigService;
    const worker = new EmailDeliveryWorker(config, prisma as never, email as unknown as NotificationEmailService);
    return { worker, prisma, email };
  }

  it('reclaims stale SENDING rows without calling SMTP', async () => {
    const context = setup();
    context.prisma.notificationEmailDelivery.findMany
      .mockResolvedValueOnce([{ id: 'delivery', notificationId: 'notification' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    context.prisma.notificationEmailDelivery.updateMany.mockResolvedValue({ count: 1 });
    await context.worker.tick();
    expect(context.prisma.notificationEmailDelivery.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: EmailDeliveryStatus.FAILED, lastErrorCode: 'STALE_SENDING' },
    }));
    expect(context.email.dispatch).not.toHaveBeenCalled();
    expect(context.email.recordDeliveryLog).toHaveBeenCalledWith('notification', 'EMAIL_STALE_SENDING_RECLAIMED', expect.any(Object));
  });

  it('dispatches PENDING manual deliveries', async () => {
    const context = setup();
    context.prisma.notificationEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ notificationId: 'pending-notification' }])
      .mockResolvedValueOnce([]);
    await context.worker.tick();
    expect(context.email.dispatch).toHaveBeenCalledWith('pending-notification');
  });

  it('auto-retries FAILED only when EMAIL_WORKER_AUTO_RETRY is enabled', async () => {
    const disabled = setup({ autoRetry: false });
    disabled.prisma.notificationEmailDelivery.findMany.mockResolvedValue([]);
    await disabled.worker.tick();
    expect(disabled.email.dispatch).not.toHaveBeenCalled();

    const enabled = setup({ autoRetry: true });
    enabled.prisma.notificationEmailDelivery.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ notificationId: 'failed-notification', attemptCount: 3 }]);
    await enabled.worker.tick();
    expect(enabled.email.dispatch).toHaveBeenCalledWith('failed-notification', true);
  });
});
