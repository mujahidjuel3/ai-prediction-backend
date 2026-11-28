import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus } from '@prisma/client';
import {
  NotificationEmailService,
  MailTransportFactory,
  BrevoFetch,
  ResendClientFactory,
  ResendSendPayload,
  ResendSendResult,
} from './notification-email.service';

const notificationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function setup(options: {
  enabled?: boolean;
  emailOptIn?: boolean;
  sendMail?: jest.Mock;
  passKey?: 'SMTP_PASS' | 'SMTP_PASSWORD';
  provider?: 'smtp' | 'brevo' | 'resend';
  brevoFetch?: jest.MockedFunction<BrevoFetch>;
  resendSend?: jest.Mock;
  resendApiKey?: string;
  emailFrom?: string;
  emailPolicyApproved?: boolean;
} = {}) {
  const sendMail = options.sendMail ?? jest.fn().mockResolvedValue({ messageId: 'smtp-message-id', accepted: ['test@example.test'] });
  let row: Record<string, unknown> = {
    id: deliveryId, notificationId, status: EmailDeliveryStatus.PENDING, attemptCount: 0,
    providerMessageId: null, lastErrorCode: null, acceptedAt: null,
    notification: {
      alertId: null,
      title: 'Manual notice',
      message: 'Synthetic test message',
      recipient: { email: 'test@example.test', preference: { email: options.emailOptIn ?? true } },
    },
  };
  const prisma = {
    notification: { findUnique: jest.fn(async () => ({ id: notificationId, alertId: null as string | null })) },
    notificationEmailDelivery: {
      findUnique: jest.fn(async () => row),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return { count: 1 }; }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => { row = { ...row, ...data }; return row; }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'log' }) },
  };
  const passKey = options.passKey ?? 'SMTP_PASS';
  const configValues: Record<string, unknown> = {
    EMAIL_PROVIDER: options.provider ?? 'smtp',
    EMAIL_POLICY_APPROVED: options.emailPolicyApproved ?? true,
    SMTP_ENABLED: options.enabled ?? true, SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: 465,
    SMTP_SECURE: true, SMTP_USER: 'sender@example.test', SMTP_FROM: 'sender@example.test',
    SMTP_FROM_NAME: 'Academic Sentinel Test', EMAIL_MAX_ATTEMPTS: 3,
    SMTP_PASS: passKey === 'SMTP_PASS' ? 'test-only-value' : '',
    SMTP_PASSWORD: passKey === 'SMTP_PASSWORD' ? 'legacy-test-value' : '',
    BREVO_API_KEY: 'test-brevo-api-key-not-real',
    BREVO_SENDER_EMAIL: 'noreply@example.test',
    BREVO_SENDER_NAME: 'Academic Sentinel Brevo',
    BREVO_TIMEOUT_MS: 5_000,
    RESEND_API_KEY: options.resendApiKey ?? 're_test_key_not_real',
    EMAIL_FROM: options.emailFrom ?? 'Academic Sentinel <admin@academicsentinel.live>',
  };
  const config = { get: (key: string) => configValues[key], getOrThrow: (key: string) => {
    const value = configValues[key];
    if (value === undefined || value === null || value === '') throw new Error(`Missing ${key}`);
    return value;
  } } as unknown as ConfigService;
  const factory = jest.fn<ReturnType<MailTransportFactory>, Parameters<MailTransportFactory>>(() => ({ sendMail }));
  const brevoFetch = options.brevoFetch ?? (jest.fn() as jest.MockedFunction<BrevoFetch>);
  const resendSend = options.resendSend
    ?? jest.fn<Promise<ResendSendResult>, [ResendSendPayload]>().mockResolvedValue({ data: { id: 'resend-message-id' }, error: null });
  const createResend: ResendClientFactory = jest.fn((apiKey: string) => {
    expect(apiKey).toBeTruthy();
    return { emails: { send: resendSend } };
  });
  const service = new NotificationEmailService(config, prisma as never, factory, async () => undefined, brevoFetch, createResend);
  return { service, prisma, factory, sendMail, brevoFetch, resendSend, createResend, setRow: (value: Record<string, unknown>) => { row = value; } };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
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

  it('records SMTP acceptance and provider message id on success using SMTP_PASS', async () => {
    const context = setup();
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
    expect(result.providerMessageId).toBe('smtp-message-id');
    expect(result.attemptCount).toBe(1);
    expect(context.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'test@example.test',
      text: 'Synthetic test message',
      from: '"Academic Sentinel Test" <sender@example.test>',
    }));
    expect(context.factory).toHaveBeenCalledWith(expect.objectContaining({
      auth: { user: 'sender@example.test', pass: 'test-only-value' },
    }));
    expect(context.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: 'EMAIL_SMTP_ACCEPTED' }),
    }));
  });

  it('accepts legacy SMTP_PASSWORD when SMTP_PASS is absent', async () => {
    const context = setup({ passKey: 'SMTP_PASSWORD' });
    await context.service.dispatch(notificationId);
    expect(context.factory).toHaveBeenCalledWith(expect.objectContaining({
      auth: { user: 'sender@example.test', pass: 'legacy-test-value' },
    }));
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
    context.setRow({
      id: deliveryId, notificationId, status: EmailDeliveryStatus.SMTP_ACCEPTED, attemptCount: 1,
      providerMessageId: 'already-sent', lastErrorCode: null, acceptedAt: new Date(),
      notification: { alertId: null, recipient: { preference: { email: true } } },
    });
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
    expect(context.factory).not.toHaveBeenCalled();
    expect(context.sendMail).not.toHaveBeenCalled();
  });

  it('does not auto-resend an in-flight SENDING delivery', async () => {
    const context = setup();
    context.setRow({
      id: deliveryId, notificationId, status: EmailDeliveryStatus.SENDING, attemptCount: 1,
      providerMessageId: null, lastErrorCode: null, acceptedAt: null,
      notification: { alertId: null, recipient: { preference: { email: true } } },
    });
    const result = await context.service.dispatch(notificationId);
    expect(result.status).toBe(EmailDeliveryStatus.SENDING);
    expect(context.sendMail).not.toHaveBeenCalled();
  });

  it('rejects dispatch and retry for a risk-alert notification', async () => {
    const context = setup();
    context.setRow({
      id: deliveryId, notificationId, status: EmailDeliveryStatus.PENDING, attemptCount: 0,
      providerMessageId: null, lastErrorCode: null, acceptedAt: null,
      notification: { alertId: 'risk-alert-id', recipient: { preference: { email: true } } },
    });
    context.prisma.notification.findUnique.mockResolvedValue({ id: notificationId, alertId: 'risk-alert-id' });
    await expect(context.service.dispatch(notificationId)).rejects.toThrow('Automated alert email is not enabled');
    await expect(context.service.retry(notificationId)).rejects.toThrow('Automated alert email is not enabled');
    expect(context.factory).not.toHaveBeenCalled();
  });

  describe('Brevo provider', () => {
    it('maps a successful Brevo response to SMTP_ACCEPTED with messageId and correct request headers/payload', async () => {
      const brevoFetch = jest.fn<ReturnType<BrevoFetch>, Parameters<BrevoFetch>>().mockResolvedValue(
        jsonResponse(201, { messageId: '<brevo-message-id@smtp-relay.brevo.com>' }),
      );
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);

      expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
      expect(result.providerMessageId).toBe('<brevo-message-id@smtp-relay.brevo.com>');
      expect(context.factory).not.toHaveBeenCalled();
      expect(brevoFetch).toHaveBeenCalledTimes(1);
      expect(brevoFetch).toHaveBeenCalledWith(
        'https://api.brevo.com/v3/smtp/email',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'api-key': 'test-brevo-api-key-not-real',
            'content-type': 'application/json',
          }),
        }),
      );
      const init = brevoFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(String(init.body));
      expect(body).toEqual(expect.objectContaining({
        sender: { name: 'Academic Sentinel Brevo', email: 'noreply@example.test' },
        to: [{ email: 'test@example.test' }],
        subject: 'Manual notice',
        textContent: 'Synthetic test message',
        htmlContent: expect.stringContaining('Synthetic test message'),
      }));
      expect(JSON.stringify(init)).not.toContain('Synthetic student');
      expect(context.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'EMAIL_SMTP_ACCEPTED',
          changes: expect.objectContaining({ provider: 'brevo' }),
        }),
      }));
    });

    it('treats HTTP 400 as non-retryable failure', async () => {
      const brevoFetch = jest.fn().mockResolvedValue(jsonResponse(400, { message: 'bad request' }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_400');
    });

    it('treats HTTP 401 as non-retryable failure', async () => {
      const brevoFetch = jest.fn().mockResolvedValue(jsonResponse(401, { message: 'unauthorized' }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_401');
    });

    it('treats HTTP 403 as non-retryable failure', async () => {
      const brevoFetch = jest.fn().mockResolvedValue(jsonResponse(403, { message: 'forbidden' }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_403');
    });

    it('retries HTTP 429 then accepts', async () => {
      const brevoFetch = jest.fn()
        .mockResolvedValueOnce(jsonResponse(429, { message: 'rate limited' }))
        .mockResolvedValueOnce(jsonResponse(201, { messageId: 'brevo-after-retry' }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
      expect(result.providerMessageId).toBe('brevo-after-retry');
    });

    it('retries HTTP 5xx then fails after max attempts', async () => {
      const brevoFetch = jest.fn().mockResolvedValue(jsonResponse(503, { message: 'unavailable' }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_5XX');
    });

    it('retries network failures then fails', async () => {
      const brevoFetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_NETWORK');
    });

    it('retries request timeout then fails', async () => {
      const brevoFetch = jest.fn().mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_TIMEOUT');
    });

    it('fails on invalid Brevo response without messageId', async () => {
      const brevoFetch = jest.fn().mockResolvedValue(jsonResponse(201, { ok: true }));
      const context = setup({ provider: 'brevo', brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(brevoFetch).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('BREVO_INVALID_RESPONSE');
    });

    it('does not call Brevo for already-accepted deliveries (idempotency)', async () => {
      const brevoFetch = jest.fn();
      const context = setup({ provider: 'brevo', brevoFetch });
      context.setRow({
        id: deliveryId, notificationId, status: EmailDeliveryStatus.SMTP_ACCEPTED, attemptCount: 1,
        providerMessageId: 'already-brevo', lastErrorCode: null, acceptedAt: new Date(),
        notification: { alertId: null, recipient: { preference: { email: true } } },
      });
      const result = await context.service.dispatch(notificationId);
      expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
      expect(brevoFetch).not.toHaveBeenCalled();
    });

    it('keeps smtp as the selected provider path when EMAIL_PROVIDER=smtp', async () => {
      const brevoFetch = jest.fn();
      const context = setup({ provider: 'smtp', brevoFetch });
      await context.service.dispatch(notificationId);
      expect(context.sendMail).toHaveBeenCalled();
      expect(brevoFetch).not.toHaveBeenCalled();
    });

    it('skips Brevo when transport is disabled even if provider is brevo', async () => {
      const brevoFetch = jest.fn();
      const context = setup({ provider: 'brevo', enabled: false, brevoFetch });
      const result = await context.service.dispatch(notificationId);
      expect(result.status).toBe(EmailDeliveryStatus.SKIPPED_DISABLED);
      expect(brevoFetch).not.toHaveBeenCalled();
    });
  });

  describe('Resend provider', () => {
    it('maps a successful Resend response to SMTP_ACCEPTED using EMAIL_FROM and never logs the API key', async () => {
      const context = setup({ provider: 'resend' });
      const result = await context.service.dispatch(notificationId);
      expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
      expect(result.providerMessageId).toBe('resend-message-id');
      expect(context.factory).not.toHaveBeenCalled();
      expect(context.brevoFetch).not.toHaveBeenCalled();
      expect(context.createResend).toHaveBeenCalledWith('re_test_key_not_real');
      expect(context.resendSend).toHaveBeenCalledWith(expect.objectContaining({
        from: 'Academic Sentinel <admin@academicsentinel.live>',
        to: 'test@example.test',
        subject: 'Manual notice',
        text: 'Synthetic test message',
        html: expect.stringContaining('Synthetic test message'),
      }));
      expect(JSON.stringify(context.prisma.auditLog.create.mock.calls)).not.toContain('re_test_key_not_real');
      expect(context.prisma.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          action: 'EMAIL_SMTP_ACCEPTED',
          changes: expect.objectContaining({ provider: 'resend' }),
        }),
      }));
    });

    it('treats Resend 401 as non-retryable failure', async () => {
      const resendSend = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'unauthorized', statusCode: 401 },
      });
      const context = setup({ provider: 'resend', resendSend });
      const result = await context.service.dispatch(notificationId);
      expect(resendSend).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('RESEND_401');
    });

    it('retries Resend 429 then accepts', async () => {
      const resendSend = jest.fn()
        .mockResolvedValueOnce({ data: null, error: { message: 'rate limited', statusCode: 429 } })
        .mockResolvedValueOnce({ data: { id: 'resend-after-retry' }, error: null });
      const context = setup({ provider: 'resend', resendSend });
      const result = await context.service.dispatch(notificationId);
      expect(resendSend).toHaveBeenCalledTimes(2);
      expect(result.status).toBe(EmailDeliveryStatus.SMTP_ACCEPTED);
      expect(result.providerMessageId).toBe('resend-after-retry');
    });

    it('retries Resend 5xx then fails after max attempts', async () => {
      const resendSend = jest.fn().mockResolvedValue({
        data: null,
        error: { message: 'unavailable', statusCode: 503 },
      });
      const context = setup({ provider: 'resend', resendSend });
      const result = await context.service.dispatch(notificationId);
      expect(resendSend).toHaveBeenCalledTimes(3);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('RESEND_5XX');
    });

    it('fails when Resend is missing an id', async () => {
      const resendSend = jest.fn().mockResolvedValue({ data: {}, error: null });
      const context = setup({ provider: 'resend', resendSend });
      const result = await context.service.dispatch(notificationId);
      expect(result.status).toBe(EmailDeliveryStatus.FAILED);
      expect(result.lastErrorCode).toBe('RESEND_INVALID_RESPONSE');
    });

    it('skips Resend when transport is disabled', async () => {
      const resendSend = jest.fn();
      const context = setup({ provider: 'resend', enabled: false, resendSend });
      const result = await context.service.dispatch(notificationId);
      expect(result.status).toBe(EmailDeliveryStatus.SKIPPED_DISABLED);
      expect(resendSend).not.toHaveBeenCalled();
    });

    it('reports provider configuration without sending mail or exposing secrets', () => {
      const context = setup({ provider: 'resend', enabled: true, emailPolicyApproved: true });
      const probe = context.service.providerConfiguration();
      expect(probe).toEqual(expect.objectContaining({
        provider: 'resend',
        emailPolicyApproved: true,
        smtpEnabled: true,
        configured: true,
        fromAddressConfigured: true,
        canSend: true,
        automatedRiskAlertEmailEnabled: false,
      }));
      expect(JSON.stringify(probe)).not.toContain('re_test_key_not_real');
      expect(context.resendSend).not.toHaveBeenCalled();
    });

    it('marks Resend unconfigured when API key is absent', () => {
      const context = setup({ provider: 'resend', resendApiKey: '' });
      const probe = context.service.providerConfiguration();
      expect(probe.configured).toBe(false);
      expect(probe.canSend).toBe(false);
    });
  });
});
