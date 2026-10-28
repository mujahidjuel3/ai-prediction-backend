import { ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
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
    if (delivery.status === EmailDeliveryStatus.SMTP_ACCEPTED || delivery.status === EmailDeliveryStatus.SENDING) return this.selectStatus(delivery);
    if (delivery.status === EmailDeliveryStatus.FAILED && !explicitRetry) return this.selectStatus(delivery);

    const preference = delivery.notification.recipient.preference;
    if (!preference?.email) {
      return this.update(delivery.id, { status: EmailDeliveryStatus.SUPPRESSED_PREFERENCE, lastErrorCode: null });
    }
    if (!this.config.get<boolean>('SMTP_ENABLED')) {
      return this.update(delivery.id, { status: EmailDeliveryStatus.SKIPPED_DISABLED, lastErrorCode: null });
    }

    const claimed = await this.prisma.notificationEmailDelivery.updateMany({
      where: { id: delivery.id, status: { in: [EmailDeliveryStatus.PENDING, EmailDeliveryStatus.FAILED, EmailDeliveryStatus.SKIPPED_DISABLED, EmailDeliveryStatus.SUPPRESSED_PREFERENCE] } },
      data: { status: EmailDeliveryStatus.SENDING, lastErrorCode: null },
    });
    if (claimed.count !== 1) return this.status(notificationId);

    const transporter = this.createTransport({
      host: this.config.getOrThrow<string>('SMTP_HOST'),
      port: this.config.getOrThrow<number>('SMTP_PORT'),
      secure: this.config.getOrThrow<boolean>('SMTP_SECURE'),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: { user: this.config.getOrThrow<string>('SMTP_USER'), pass: this.config.getOrThrow<string>('SMTP_PASSWORD') },
    });
    const recipient = delivery.notification.recipient;
    let lastCode = 'SMTP_ERROR';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.prisma.notificationEmailDelivery.update({ where: { id: delivery.id }, data: { attemptCount: attempt } });
      try {
        const result = await transporter.sendMail({
          from: this.config.getOrThrow<string>('SMTP_FROM'),
          to: recipient.email,
          subject: delivery.notification.title,
          text: delivery.notification.message,
        });
        if (!result.accepted?.length) {
          throw Object.assign(new Error('SMTP did not accept the recipient'), { code: 'EADDRESSREJECTED' });
        }
        return this.update(delivery.id, {
          status: EmailDeliveryStatus.SMTP_ACCEPTED,
          providerMessageId: result.messageId.slice(0, 255),
          acceptedAt: new Date(),
          lastErrorCode: null,
        });
      } catch (cause) {
        lastCode = this.safeErrorCode(cause);
        if (attempt === 3 || !this.isTransient(cause)) break;
        await this.delay(200 * (2 ** (attempt - 1)));
      }
    }
    return this.update(delivery.id, { status: EmailDeliveryStatus.FAILED, lastErrorCode: lastCode });
  }

  async retry(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id: notificationId }, select: { id: true, alertId: true } });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.alertId) throw new ConflictException('Automated alert email is not enabled');
    return this.dispatch(notificationId, true);
  }

  private update(id: string, data: Prisma.NotificationEmailDeliveryUpdateInput) {
    return this.prisma.notificationEmailDelivery.update({ where: { id }, data, select: publicFields });
  }

  private selectStatus(delivery: { id: string; status: EmailDeliveryStatus; attemptCount: number; providerMessageId: string | null; lastErrorCode: string | null; acceptedAt: Date | null }) {
    return { id: delivery.id, status: delivery.status, attemptCount: delivery.attemptCount, providerMessageId: delivery.providerMessageId, lastErrorCode: delivery.lastErrorCode, acceptedAt: delivery.acceptedAt };
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
