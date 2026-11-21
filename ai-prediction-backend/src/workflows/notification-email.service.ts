import { ConflictException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus, Prisma } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { PrismaService } from '../prisma/prisma.module';

export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');
export const MAIL_RETRY_DELAY = Symbol('MAIL_RETRY_DELAY');
export type MailTransport = Pick<nodemailer.Transporter, 'sendMail'>;
export type MailTransportFactory = (options: SMTPTransport.Options) => MailTransport;
type Delay = (milliseconds: number) => Promise<void>;

const publicFields = { id: true, status: true, attemptCount: true, providerMessageId: true, lastErrorCode: true, acceptedAt: true } as const;
const retryableCodes = new Set(['ECONNECTION', 'ECONNRESET', 'ETIMEDOUT', 'ESOCKET', 'EAI_AGAIN', 'ETLS']);

@Injectable()
export class NotificationEmailService {
  private readonly logger = new Logger(NotificationEmailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(MAIL_TRANSPORT_FACTORY) private readonly createTransport: MailTransportFactory,
    @Optional() @Inject(MAIL_RETRY_DELAY) private readonly delay: Delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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

    await this.recordDeliveryLog(notificationId, 'EMAIL_SENDING', { deliveryId: delivery.id, explicitRetry });

    const transporter = this.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.getOrThrow<number>('SMTP_PORT'),
      secure: this.config.getOrThrow<boolean>('SMTP_SECURE'),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: this.config.getOrThrow<string>('SMTP_USER'), pass: this.resolveSmtpPassword() },
    });
    const recipient = delivery.notification.recipient;
    const maxAttempts = this.config.get<number>('EMAIL_MAX_ATTEMPTS') ?? 3;
    let lastCode = 'SMTP_ERROR';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.prisma.notificationEmailDelivery.update({ where: { id: delivery.id }, data: { attemptCount: attempt } });
      try {
        const result = await transporter.sendMail({
          from: this.formatFromAddress(),
          to: recipient.email,
          subject: delivery.notification.title,
          text: delivery.notification.message,
        });
        if (!result.accepted?.length) {
          throw Object.assign(new Error('SMTP did not accept the recipient'), { code: 'EADDRESSREJECTED' });
        }
        const accepted = await this.update(delivery.id, {
          status: EmailDeliveryStatus.SMTP_ACCEPTED,
          providerMessageId: result.messageId.slice(0, 255),
          acceptedAt: new Date(),
          lastErrorCode: null,
        });
        await this.recordDeliveryLog(notificationId, 'EMAIL_SMTP_ACCEPTED', {
          deliveryId: delivery.id,
          attempt,
          providerMessageId: accepted.providerMessageId,
          note: 'SMTP acceptance is not confirmed inbox delivery',
        });
        this.logger.log({
          event: 'email_smtp_accepted',
          notificationId,
          deliveryId: delivery.id,
          attempt,
          providerMessageId: accepted.providerMessageId,
        });
        return accepted;
      } catch (cause) {
        lastCode = this.safeErrorCode(cause);
        this.logger.warn({
          event: 'email_smtp_attempt_failed',
          notificationId,
          deliveryId: delivery.id,
          attempt,
          lastErrorCode: lastCode,
        });
        if (attempt === maxAttempts || !this.isTransient(cause)) break;
        await this.delay(200 * (2 ** (attempt - 1)));
      }
    }
    const failed = await this.update(delivery.id, { status: EmailDeliveryStatus.FAILED, lastErrorCode: lastCode });
    await this.recordDeliveryLog(notificationId, 'EMAIL_FAILED', {
      deliveryId: delivery.id,
      lastErrorCode: lastCode,
      attemptCount: failed.attemptCount,
    });
    return failed;
  }

  async retry(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId }, select: { id: true, alertId: true } });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.alertId) throw new ConflictException('Automated alert email is not enabled');
    return this.dispatch(notificationId, true);
  }

  /** Structured delivery evidence without recipient address, body, or SMTP secrets. */
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

  private formatFromAddress() {
    const from = this.config.getOrThrow<string>('SMTP_FROM');
    const name = (this.config.get<string>('SMTP_FROM_NAME') || 'Academic Sentinel').trim();
    if (!name || from.includes('<')) return from;
    const escaped = name.replace(/["\\]/g, '');
    return `"${escaped}" <${from}>`;
  }

  private safeErrorCode(cause: unknown) {
    if (!cause || typeof cause !== 'object') return 'SMTP_ERROR';
    const code = 'code' in cause ? String(cause.code) : 'SMTP_ERROR';
    return /^[A-Z0-9_-]{1,120}$/.test(code) ? code : 'SMTP_ERROR';
  }

  private isTransient(cause: unknown) {
    if (!cause || typeof cause !== 'object') return false;
    const code = 'code' in cause ? String(cause.code) : '';
    const responseCode = 'responseCode' in cause ? Number(cause.responseCode) : 0;
    return retryableCodes.has(code) || (responseCode >= 400 && responseCode < 500);
  }
}

export const mailTransportFactoryProvider = {
  provide: MAIL_TRANSPORT_FACTORY,
  useValue: (options: SMTPTransport.Options) => nodemailer.createTransport(options),
};
