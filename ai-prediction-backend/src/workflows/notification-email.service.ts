import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus, Prisma } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.module';

export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');
export const MAIL_RETRY_DELAY = Symbol('MAIL_RETRY_DELAY');
export const BREVO_FETCH = Symbol('BREVO_FETCH');
export const RESEND_CLIENT_FACTORY = Symbol('RESEND_CLIENT_FACTORY');

export type MailTransport = Pick<nodemailer.Transporter, 'sendMail'>;
export type MailTransportFactory = (options: SMTPTransport.Options) => MailTransport;
export type BrevoFetch = typeof fetch;
export type ResendSendPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
};
export type ResendSendResult = { data: { id: string } | null; error: { message: string; name?: string; statusCode?: number } | null };
export type ResendClient = { emails: { send: (payload: ResendSendPayload) => Promise<ResendSendResult> } };
export type ResendClientFactory = (apiKey: string) => ResendClient;

function createOfficialResendClient(apiKey: string): ResendClient {
  const client = new Resend(apiKey);
  return {
    emails: {
      send: (payload) => client.emails.send(payload) as Promise<ResendSendResult>,
    },
  };
}
type Delay = (milliseconds: number) => Promise<void>;
export type EmailProvider = 'smtp' | 'brevo' | 'resend';

const publicFields = { id: true, status: true, attemptCount: true, providerMessageId: true, lastErrorCode: true, acceptedAt: true } as const;
const smtpRetryableCodes = new Set(['ECONNECTION', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'EAI_AGAIN', 'ETLS']);
const brevoRetryableCodes = new Set(['BREVO_429', 'BREVO_5XX', 'BREVO_TIMEOUT', 'BREVO_NETWORK', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);
const resendRetryableCodes = new Set(['RESEND_429', 'RESEND_5XX', 'RESEND_TIMEOUT', 'RESEND_NETWORK', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_EMAIL_FROM = 'Academic Sentinel <admin@academicsentinel.live>';

class ProviderSendError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderSendError';
  }
}

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(MAIL_TRANSPORT_FACTORY) private readonly createTransport: MailTransportFactory,
    @Optional() @Inject(MAIL_RETRY_DELAY) private readonly delay: Delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    @Optional() @Inject(BREVO_FETCH) private readonly brevoFetch: BrevoFetch = fetch,
    @Optional() @Inject(RESEND_CLIENT_FACTORY) private readonly createResendClient: ResendClientFactory = createOfficialResendClient,
  ) {}

  async status(notificationId: string) {
    const delivery = await this.prisma.notificationEmailDelivery.findUnique({ where: { notificationId }, select: publicFields });
    if (!delivery) throw new NotFoundException('Email delivery record not found');
    return delivery;
  }

  /**
   * Configuration probe for Admin diagnostics. Does not send email and never returns secrets.
   */
  providerConfiguration() {
    const provider = this.resolveProvider();
    const emailPolicyApproved = this.config.get<boolean>('EMAIL_POLICY_APPROVED') === true;
    const smtpEnabled = this.config.get<boolean>('SMTP_ENABLED') === true;
    const configured = this.isProviderConfigured(provider);
    return {
      provider,
      emailPolicyApproved,
      smtpEnabled,
      configured,
      fromAddressConfigured: Boolean(this.resolveFromAddress(provider)),
      canSend: emailPolicyApproved && smtpEnabled && configured,
      automatedRiskAlertEmailEnabled: false,
      disclaimer:
        'Configuration check only; no email was sent. SMTP_ACCEPTED means provider acceptance only. Automated ML risk-alert email remains disabled.',
    };
  }

  async dispatch(notificationId: string, explicitRetry = false) {
    const delivery = await this.prisma.notificationEmailDelivery.findUnique({
      where: { notificationId },
      include: { notification: { include: { recipient: { include: { preference: true } } } } },
    });
    if (!delivery) throw new NotFoundException('Email delivery record not found');
    if (delivery.notification.alertId) {
      await this.recordDeliveryLog(notificationId, 'EMAIL_ALERT_BLOCKED', { reason: 'automated_ml_risk_alert_disabled' });
      throw new ConflictException('Automated alert email is not enabled');
    }
    if (delivery.status === EmailDeliveryStatus.SMTP_ACCEPTED || delivery.status === EmailDeliveryStatus.SENDING) {
      await this.recordDeliveryLog(notificationId, 'EMAIL_DISPATCH_SKIPPED', {
        status: delivery.status,
        reason: delivery.status === EmailDeliveryStatus.SMTP_ACCEPTED ? 'already_accepted' : 'in_flight',
      });
      return this.selectStatus(delivery);
    }
    if (delivery.status === EmailDeliveryStatus.FAILED && !explicitRetry) return this.selectStatus(delivery);

    const preference = delivery.notification.recipient.preference;
    if (!preference?.email) {
      const updated = await this.update(delivery.id, { status: EmailDeliveryStatus.SUPPRESSED_PREFERENCE, lastErrorCode: null });
      await this.recordDeliveryLog(notificationId, 'EMAIL_SUPPRESSED_PREFERENCE', { deliveryId: delivery.id });
      return updated;
    }
    if (!this.config.get<boolean>('SMTP_ENABLED')) {
      const updated = await this.update(delivery.id, { status: EmailDeliveryStatus.SKIPPED_DISABLED, lastErrorCode: null });
      await this.recordDeliveryLog(notificationId, 'EMAIL_SKIPPED_DISABLED', { deliveryId: delivery.id });
      return updated;
    }

    const claimed = await this.prisma.notificationEmailDelivery.updateMany({
      where: { id: delivery.id, status: { in: [EmailDeliveryStatus.PENDING, EmailDeliveryStatus.FAILED, EmailDeliveryStatus.SKIPPED_DISABLED, EmailDeliveryStatus.SUPPRESSED_PREFERENCE] } },
      data: { status: EmailDeliveryStatus.SENDING, lastErrorCode: null },
    });
    if (claimed.count !== 1) return this.status(notificationId);

    const provider = this.resolveProvider();
    await this.recordDeliveryLog(notificationId, 'EMAIL_SENDING', { deliveryId: delivery.id, explicitRetry, provider });

    const recipient = delivery.notification.recipient;
    const maxAttempts = this.config.get<number>('EMAIL_MAX_ATTEMPTS') ?? 3;
    let lastCode = this.defaultErrorCode(provider);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.prisma.notificationEmailDelivery.update({ where: { id: delivery.id }, data: { attemptCount: attempt } });
      try {
        const payload = {
          to: recipient.email,
          subject: delivery.notification.title,
          text: delivery.notification.message,
        };
        const providerMessageId = provider === 'resend'
          ? await this.sendViaResend(payload)
          : provider === 'brevo'
            ? await this.sendViaBrevo(payload)
            : await this.sendViaSmtp(payload);

        const accepted = await this.update(delivery.id, {
          status: EmailDeliveryStatus.SMTP_ACCEPTED,
          providerMessageId: providerMessageId.slice(0, 255),
          acceptedAt: new Date(),
          lastErrorCode: null,
        });
        await this.recordDeliveryLog(notificationId, 'EMAIL_SMTP_ACCEPTED', {
          deliveryId: delivery.id,
          attempt,
          provider,
          providerMessageId: accepted.providerMessageId,
          note: 'Provider acceptance is not confirmed inbox delivery',
        });
        this.logger.log({
          event: 'email_provider_accepted',
          notificationId,
          deliveryId: delivery.id,
          attempt,
          provider,
          providerMessageId: accepted.providerMessageId,
        });
        return accepted;
      } catch (cause) {
        lastCode = this.safeErrorCode(cause, provider);
        this.logger.warn({
          event: 'email_provider_attempt_failed',
          notificationId,
          deliveryId: delivery.id,
          attempt,
          provider,
          lastErrorCode: lastCode,
        });
        if (attempt === maxAttempts || !this.isTransient(cause, provider)) break;
        await this.delay(200 * (2 ** (attempt - 1)));
      }
    }
    const failed = await this.update(delivery.id, { status: EmailDeliveryStatus.FAILED, lastErrorCode: lastCode });
    await this.recordDeliveryLog(notificationId, 'EMAIL_FAILED', {
      deliveryId: delivery.id,
      lastErrorCode: lastCode,
      attemptCount: failed.attemptCount,
      provider,
    });
    return failed;
  }

  async retry(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId }, select: { id: true, alertId: true } });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.alertId) throw new ConflictException('Automated alert email is not enabled');
    return this.dispatch(notificationId, true);
  }

  /** Structured delivery evidence without recipient address, body, or provider secrets. */
  async recordDeliveryLog(notificationId: string, action: string, changes: Prisma.InputJsonValue) {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: null,
          action,
          entityType: 'NotificationEmailDelivery',
          entityId: notificationId,
          changes,
        },
      });
    } catch (cause) {
      this.logger.warn({
        event: 'email_delivery_log_failed',
        notificationId,
        action,
        code: cause instanceof Error ? cause.name : 'LOG_ERROR',
      });
    }
  }

  private async sendViaSmtp(input: { to: string; subject: string; text: string }) {
    const transporter = this.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.getOrThrow<number>('SMTP_PORT'),
      secure: this.config.getOrThrow<boolean>('SMTP_SECURE'),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: this.config.getOrThrow<string>('SMTP_USER'), pass: this.resolveSmtpPassword() },
    });
    const result = await transporter.sendMail({
      from: this.formatSmtpFromAddress(),
      to: input.to,
      subject: input.subject,
      text: input.text,
    });
    if (!result.accepted?.length) {
      throw new ProviderSendError('EADDRESSREJECTED', 'SMTP did not accept the recipient', false);
    }
    return result.messageId;
  }

  private async sendViaBrevo(input: { to: string; subject: string; text: string }) {
    const apiKey = this.config.get<string>('BREVO_API_KEY');
    const senderEmail = this.config.get<string>('BREVO_SENDER_EMAIL');
    if (!apiKey || !senderEmail) {
      throw new ProviderSendError('BREVO_CONFIG', 'Brevo configuration is incomplete', false);
    }
    const senderName = (this.config.get<string>('BREVO_SENDER_NAME') || 'Academic Sentinel').trim() || 'Academic Sentinel';
    const timeoutMs = this.config.get<number>('BREVO_TIMEOUT_MS') ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await this.brevoFetch(BREVO_API_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          sender: { name: senderName, email: senderEmail },
          to: [{ email: input.to }],
          subject: input.subject,
          textContent: input.text,
          htmlContent: this.toSafeHtml(input.text),
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (cause instanceof Error && (cause.name === 'AbortError' || cause.message.toLowerCase().includes('aborted'))) {
        throw new ProviderSendError('BREVO_TIMEOUT', 'Brevo request timed out', true);
      }
      throw new ProviderSendError('BREVO_NETWORK', 'Brevo network failure', true);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ProviderSendError(`BREVO_${response.status}`, 'Brevo authentication failed', false);
    }
    if (response.status === 400) {
      throw new ProviderSendError('BREVO_400', 'Brevo rejected the request', false);
    }
    if (response.status === 429) {
      throw new ProviderSendError('BREVO_429', 'Brevo rate limited the request', true);
    }
    if (response.status >= 500) {
      throw new ProviderSendError('BREVO_5XX', 'Brevo provider error', true);
    }
    if (!response.ok) {
      throw new ProviderSendError('BREVO_ERROR', 'Brevo request failed', false);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderSendError('BREVO_INVALID_RESPONSE', 'Brevo returned an invalid response body', false);
    }
    const messageId = this.extractBrevoMessageId(payload);
    if (!messageId) {
      throw new ProviderSendError('BREVO_INVALID_RESPONSE', 'Brevo response did not include messageId', false);
    }
    return messageId;
  }

  private extractBrevoMessageId(payload: unknown) {
    if (!payload || typeof payload !== 'object') return null;
    const messageId = 'messageId' in payload ? payload.messageId : null;
    return typeof messageId === 'string' && messageId.trim() ? messageId.trim() : null;
  }

  private async sendViaResend(input: { to: string; subject: string; text: string }) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      throw new ProviderSendError('RESEND_CONFIG', 'Resend configuration is incomplete', false);
    }
    const from = this.resolveFromAddress('resend');
    if (!from) {
      throw new ProviderSendError('RESEND_CONFIG', 'Resend sender address is not configured', false);
    }
    let result: ResendSendResult;
    try {
      const client = this.createResendClient(apiKey);
      result = await client.emails.send({
        from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: this.toSafeHtml(input.text),
      });
    } catch (cause) {
      if (cause instanceof Error && (cause.name === 'AbortError' || /timeout|aborted/i.test(cause.message))) {
        throw new ProviderSendError('RESEND_TIMEOUT', 'Resend request timed out', true);
      }
      throw new ProviderSendError('RESEND_NETWORK', 'Resend network failure', true);
    }

    if (result.error) {
      const statusCode = typeof result.error.statusCode === 'number' ? result.error.statusCode : 0;
      if (statusCode === 401 || statusCode === 403) {
        throw new ProviderSendError(`RESEND_${statusCode}`, 'Resend authentication failed', false);
      }
      if (statusCode === 400 || statusCode === 422) {
        throw new ProviderSendError('RESEND_400', 'Resend rejected the request', false);
      }
      if (statusCode === 429) {
        throw new ProviderSendError('RESEND_429', 'Resend rate limited the request', true);
      }
      if (statusCode >= 500) {
        throw new ProviderSendError('RESEND_5XX', 'Resend provider error', true);
      }
      const name = typeof result.error.name === 'string' ? result.error.name : '';
      if (/rate.?limit/i.test(name) || /rate.?limit/i.test(result.error.message)) {
        throw new ProviderSendError('RESEND_429', 'Resend rate limited the request', true);
      }
      throw new ProviderSendError('RESEND_ERROR', 'Resend request failed', false);
    }

    const messageId = result.data?.id;
    if (!messageId || typeof messageId !== 'string' || !messageId.trim()) {
      throw new ProviderSendError('RESEND_INVALID_RESPONSE', 'Resend response did not include id', false);
    }
    return messageId.trim();
  }

  private toSafeHtml(text: string) {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
    return `<p>${escaped.replace(/\r\n|\r|\n/g, '<br/>')}</p>`;
  }

  private resolveProvider(): EmailProvider {
    const raw = (this.config.get<string>('EMAIL_PROVIDER') || 'smtp').toLowerCase();
    if (raw === 'brevo') return 'brevo';
    if (raw === 'resend') return 'resend';
    return 'smtp';
  }

  private isProviderConfigured(provider: EmailProvider): boolean {
    if (provider === 'resend') return Boolean(this.config.get<string>('RESEND_API_KEY'));
    if (provider === 'brevo') {
      return Boolean(this.config.get<string>('BREVO_API_KEY') && this.config.get<string>('BREVO_SENDER_EMAIL'));
    }
    return Boolean(
      this.config.get<string>('SMTP_USER')
      && this.config.get<string>('SMTP_FROM')
      && (this.config.get<string>('SMTP_PASS') || this.config.get<string>('SMTP_PASSWORD')),
    );
  }

  private resolveFromAddress(provider: EmailProvider): string | null {
    if (provider === 'resend') {
      const from = (this.config.get<string>('EMAIL_FROM') || DEFAULT_EMAIL_FROM).trim();
      return from || null;
    }
    if (provider === 'brevo') {
      const email = this.config.get<string>('BREVO_SENDER_EMAIL');
      if (!email) return null;
      const name = (this.config.get<string>('BREVO_SENDER_NAME') || 'Academic Sentinel').trim() || 'Academic Sentinel';
      return email.includes('<') ? email : `"${name.replace(/["\\]/g, '')}" <${email}>`;
    }
    const from = this.config.get<string>('SMTP_FROM');
    return from ? this.formatSmtpFromAddress() : null;
  }

  private defaultErrorCode(provider: EmailProvider) {
    if (provider === 'resend') return 'RESEND_ERROR';
    if (provider === 'brevo') return 'BREVO_ERROR';
    return 'SMTP_ERROR';
  }

  private update(id: string, data: Prisma.NotificationEmailDeliveryUpdateInput) {
    return this.prisma.notificationEmailDelivery.update({ where: { id }, data, select: publicFields });
  }

  private selectStatus(delivery: { id: string; status: EmailDeliveryStatus; attemptCount: number; providerMessageId: string | null; lastErrorCode: string | null; acceptedAt: Date | null }) {
    return { id: delivery.id, status: delivery.status, attemptCount: delivery.attemptCount, providerMessageId: delivery.providerMessageId, lastErrorCode: delivery.lastErrorCode, acceptedAt: delivery.acceptedAt };
  }

  private resolveSmtpPassword() {
    const pass = this.config.get<string>('SMTP_PASS') || this.config.get<string>('SMTP_PASSWORD');
    if (!pass) throw new Error('SMTP_PASS or SMTP_PASSWORD is required when SMTP is enabled');
    return pass;
  }

  private formatSmtpFromAddress() {
    const from = this.config.getOrThrow<string>('SMTP_FROM');
    const name = (this.config.get<string>('SMTP_FROM_NAME') || 'Academic Sentinel').trim();
    if (!name || from.includes('<')) return from;
    const escaped = name.replace(/["\\]/g, '');
    return `"${escaped}" <${from}>`;
  }

  private safeErrorCode(cause: unknown, provider: EmailProvider) {
    if (cause instanceof ProviderSendError) return cause.code;
    const fallback = this.defaultErrorCode(provider);
    if (!cause || typeof cause !== 'object') return fallback;
    const code = 'code' in cause ? String(cause.code) : fallback;
    return /^[A-Z0-9_-]{1,120}$/.test(code) ? code : fallback;
  }

  private isTransient(cause: unknown, provider: EmailProvider) {
    if (cause instanceof ProviderSendError) return cause.retryable;
    if (!cause || typeof cause !== 'object') return false;
    const code = 'code' in cause ? String(cause.code) : '';
    if (provider === 'brevo') return brevoRetryableCodes.has(code);
    if (provider === 'resend') return resendRetryableCodes.has(code);
    const responseCode = 'responseCode' in cause ? Number(cause.responseCode) : 0;
    return smtpRetryableCodes.has(code) || (responseCode >= 400 && responseCode < 500);
  }
}

export const mailTransportFactoryProvider = {
  provide: MAIL_TRANSPORT_FACTORY,
  useValue: (options: SMTPTransport.Options) => nodemailer.createTransport(options),
};

export const brevoFetchProvider = {
  provide: BREVO_FETCH,
  useValue: fetch,
};

export const resendClientFactoryProvider = {
  provide: RESEND_CLIENT_FACTORY,
  useValue: createOfficialResendClient,
};
