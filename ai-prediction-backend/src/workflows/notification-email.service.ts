import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus, Prisma } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { PrismaService } from '../prisma/prisma.module';

export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');
export const MAIL_RETRY_DELAY = Symbol('MAIL_RETRY_DELAY');
export const BREVO_FETCH = Symbol('BREVO_FETCH');

export type MailTransport = Pick<nodemailer.Transporter, 'sendMail'>;
export type MailTransportFactory = (options: SMTPTransport.Options) => MailTransport;
export type BrevoFetch = typeof fetch;
type Delay = (milliseconds: number) => Promise<void>;
type EmailProvider = 'smtp' | 'brevo';

const publicFields = { id: true, status: true, attemptCount: true, providerMessageId: true, lastErrorCode: true, acceptedAt: true } as const;
const smtpRetryableCodes = new Set(['ECONNECTION', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'EAI_AGAIN', 'ETLS']);
const brevoRetryableCodes = new Set(['BREVO_429', 'BREVO_5XX', 'BREVO_TIMEOUT', 'BREVO_NETWORK', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN']);
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

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
  ) {}

  async status(notificationId: string) {
    const delivery = await this.prisma.notificationEmailDelivery.findUnique({ where: { notificationId }, select: publicFields });
    if (!delivery) throw new NotFoundException('Email delivery record not found');
    return delivery;
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
    let lastCode = provider === 'brevo' ? 'BREVO_ERROR' : 'SMTP_ERROR';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.prisma.notificationEmailDelivery.update({ where: { id: delivery.id }, data: { attemptCount: attempt } });
      try {
        const providerMessageId = provider === 'brevo'
          ? await this.sendViaBrevo({
              to: recipient.email,
              subject: delivery.notification.title,
              text: delivery.notification.message,
            })
          : await this.sendViaSmtp({
              to: recipient.email,
              subject: delivery.notification.title,
              text: delivery.notification.message,
            });

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
    return raw === 'brevo' ? 'brevo' : 'smtp';
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
    if (!cause || typeof cause !== 'object') return provider === 'brevo' ? 'BREVO_ERROR' : 'SMTP_ERROR';
    const code = 'code' in cause ? String(cause.code) : provider === 'brevo' ? 'BREVO_ERROR' : 'SMTP_ERROR';
    return /^[A-Z0-9_-]{1,120}$/.test(code) ? code : provider === 'brevo' ? 'BREVO_ERROR' : 'SMTP_ERROR';
  }

  private isTransient(cause: unknown, provider: EmailProvider) {
    if (cause instanceof ProviderSendError) return cause.retryable;
    if (!cause || typeof cause !== 'object') return false;
    const code = 'code' in cause ? String(cause.code) : '';
    if (provider === 'brevo') return brevoRetryableCodes.has(code);
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
