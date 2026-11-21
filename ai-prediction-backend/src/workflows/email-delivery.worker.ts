import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailDeliveryStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { NotificationEmailService } from './notification-email.service';

/**
 * Background queue processor for manual-message email deliveries.
 * Does not auto-resend SENDING rows (ambiguous SMTP acceptance risk).
 * Does not process alert-linked notifications (ML risk alerts remain disabled).
 */
@Injectable()
export class EmailDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailDeliveryWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly email: NotificationEmailService,
  ) {}

  onModuleInit() {
    if (!this.config.get<boolean>('EMAIL_WORKER_ENABLED')) {
      this.logger.log({ event: 'email_worker_disabled' }, 'Email delivery worker is disabled');
      return;
    }
    const intervalMs = this.config.get<number>('EMAIL_WORKER_INTERVAL_MS') ?? 15_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.log({ event: 'email_worker_started', intervalMs }, 'Email delivery worker started');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.reclaimStaleSending();
      await this.processPending();
      await this.processFailedRetries();
    } catch (cause) {
      this.logger.warn({
        event: 'email_worker_tick_failed',
        code: cause instanceof Error ? cause.name : 'WORKER_ERROR',
      });
    } finally {
      this.running = false;
    }
  }

  private async reclaimStaleSending() {
    const staleMs = this.config.get<number>('EMAIL_STALE_SENDING_MS') ?? 300_000;
    const cutoff = new Date(Date.now() - staleMs);
    const stale = await this.prisma.notificationEmailDelivery.findMany({
      where: {
        status: EmailDeliveryStatus.SENDING,
        updatedAt: { lt: cutoff },
        notification: { alertId: null },
      },
      select: { id: true, notificationId: true },
      take: 25,
    });
    for (const row of stale) {
      const updated = await this.prisma.notificationEmailDelivery.updateMany({
        where: { id: row.id, status: EmailDeliveryStatus.SENDING },
        data: { status: EmailDeliveryStatus.FAILED, lastErrorCode: 'STALE_SENDING' },
      });
      if (updated.count === 1) {
        await this.email.recordDeliveryLog(row.notificationId, 'EMAIL_STALE_SENDING_RECLAIMED', {
          deliveryId: row.id,
          lastErrorCode: 'STALE_SENDING',
        });
        this.logger.warn({
          event: 'email_stale_sending_reclaimed',
          notificationId: row.notificationId,
          deliveryId: row.id,
        });
      }
    }
  }

  private async processPending() {
    const batchSize = this.config.get<number>('EMAIL_WORKER_BATCH_SIZE') ?? 10;
    const pending = await this.prisma.notificationEmailDelivery.findMany({
      where: {
        status: EmailDeliveryStatus.PENDING,
        notification: { alertId: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { notificationId: true },
      take: batchSize,
    });
    for (const row of pending) {
      const result = await this.email.dispatch(row.notificationId);
      this.logger.log({
        event: 'email_worker_dispatched_pending',
        notificationId: row.notificationId,
        status: result.status,
        attemptCount: result.attemptCount,
        lastErrorCode: result.lastErrorCode,
      });
    }
  }

  private async processFailedRetries() {
    if (!this.config.get<boolean>('EMAIL_WORKER_AUTO_RETRY')) return;
    const maxDispatchRounds = this.config.get<number>('EMAIL_MAX_DISPATCH_ROUNDS') ?? 2;
    const maxAttemptsPerRound = 3;
    const maxAttemptBudget = maxDispatchRounds * maxAttemptsPerRound;
    const backoffMs = this.config.get<number>('EMAIL_RETRY_BACKOFF_MS') ?? 60_000;
    const cutoff = new Date(Date.now() - backoffMs);
    const batchSize = this.config.get<number>('EMAIL_WORKER_BATCH_SIZE') ?? 10;
    const failed = await this.prisma.notificationEmailDelivery.findMany({
      where: {
        status: EmailDeliveryStatus.FAILED,
        lastErrorCode: { not: 'STALE_SENDING' },
        attemptCount: { lt: maxAttemptBudget },
        updatedAt: { lt: cutoff },
        notification: { alertId: null },
      },
      orderBy: { updatedAt: 'asc' },
      select: { notificationId: true, attemptCount: true },
      take: batchSize,
    });
    for (const row of failed) {
      const result = await this.email.dispatch(row.notificationId, true);
      this.logger.log({
        event: 'email_worker_auto_retry',
        notificationId: row.notificationId,
        status: result.status,
        attemptCount: result.attemptCount,
        lastErrorCode: result.lastErrorCode,
      });
    }
  }
}
