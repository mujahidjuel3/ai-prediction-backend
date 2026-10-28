import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus } from '@prisma/client';
import { NotificationEmailService, MailTransportFactory } from './notification-email.service';

const notificationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(options: { enabled?: boolean; emailOptIn?: boolean; sendMail?: jest.Mock } = {}) {
  const sendMail = options.sendMail ?? jest.fn().mockResolvedValue({ messageId: 'smtp-message-id', accepted: ['test@example.test'] });
  let row: Record<string, unknown> = {
    id: deliveryId, notificationId, status: EmailDeliveryStatus.PENDING, attemptCount: 0,
    providerMessageId: null, lastErrorCode: null, acceptedAt: null,
    notification: { title: 'Manual notice', message: 'Synthetic test message', recipient: { email: 'test@example.test', preference: { email: options.emailOptIn ?? true } } },
  };
  const prisma = {
    notification: { findUnique: jest.fn(async () => ({ id: notificationId, alertId: null as string | null })) },
    notificationEmailDelivery: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return { count: 1 }; }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return row; }),
    },
  };
  const configValues: Record<string, unknown> = {
    SMTP_ENABLED: options.enabled ?? true, SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465,
    SMTP_SECURE: true, SMTP_USER: 'sender@example.test', SMTP_PASSWORD: 'test-only-value', SMTP_FROM: 'Academic Sentinel <sender@example.test>',
  };
  const config = { get: (key: string) => configValues[key], getOrThrow: (key: string) => configValues[key] } as unknown as ConfigService;
  const factory = jest.fn<ReturnType<MailTransportFactory>, Parameters<MailTransportFactory>>(() => ({ sendMail }));
  const service = new NotificationEmailService(config, prisma as never, factory, async () => undefined);
  return { service, prisma, factory, sendMail, setRow: (value: Record<string, unknown>) => { row = value; } };
}

describe('NotificationEmailService', () => {
  it('records disabled email configuration without calling SMTP', async () => {
    const context = setup({ enabled: false });
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SKIPPED_DISABLED);
    expect(context.factory).not.toHaveBeenCalled();
  });

  it('suppresses email when the recipient has not opted in', async () => {
    const context = setup({ emailOptIn: false });
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SUPPRESSED_PREFERENCE);
    expect(context.factory).not.toHaveBeenCalled();
  });

  it('records SMTP acceptance and provider message id on success', async () => {
    const context = setup();
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
    expect(result.providerMessageId).toBe('smtp-message-id');
    expect(result.attemptCount).toBe(1);
    expect(context.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'test@example.test', text: 'Synthetic test message' }));
  });

  it('retries transient SMTP failures and then records acceptance', async () => {
    const sendMail = jest.fn().mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'ECONNECTION' })).mockRejectedValueOnce(Object.assign(new Error('temporary'), { responseCode: 450 })).mockResolvedValueOnce({ messageId: 'retry-accepted', accepted: ['test@example.test'] });
    const context = setup({ sendMail });
    const result = await context.service.dispatch(notificationId);
    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
    expect(result.attemptCount).toBe(3);
  });

  it('persists permanent SMTP failure without leaking provider error text', async () => {
    const sendMail = jest.fn().mockRejectedValue(Object.assign(new Error('private SMTP response content'), { responseCode: 550 }));
    const context = setup({ sendMail });
    const result = await context.service.dispatch(notificationId);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(EmailDeliveryStatus.FAILED);
    expect(result.lastErrorCode).toBe('SMTP_ERROR');
  });

  it('does not claim SMTP acceptance when the provider rejects the recipient', async () => {
    const context = setup({ sendMail: jest.fn().mockResolvedValue({ messageId: 'rejected-id', accepted: [], rejected: ['test@example.test'] }) });
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.FAILED);
    expect(result.lastErrorCode).toBe('EADDRESSREJECTED');
  });

  it('does not send a duplicate event already accepted by SMTP', async () => {
    const context = setup();
    context.setRow({ id: deliveryId, notificationId, status: EmailDeliveryStatus.SMTP_ACCEPTED, attemptCount: 1, providerMessageId: 'already-sent', lastErrorCode: null, acceptedAt: new Date(), notification: { recipient: { preference: { email: true } } } });
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
    expect(context.factory).not.toHaveBeenCalled();
    expect(context.sendMail).not.toHaveBeenCalled();
  });

  it('rejects retrying email for a risk-alert notification', async () => {
    const context = setup();
    context.prisma.notification.findUnique.mockResolvedValue({ id: notificationId, alertId: 'risk-alert-id' });
    await expect(context.service.retry(notificationId)).rejects.toThrow('Automated alert email is not enabled');
    expect(context.factory).not.toHaveBeenCalled();
  });
});
