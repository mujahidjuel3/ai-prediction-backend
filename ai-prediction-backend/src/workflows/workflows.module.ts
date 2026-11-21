import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MlModule } from '../ml/ml.module';
import { WorkflowsController } from './workflows.controller';
import { NotificationEmailService, mailTransportFactoryProvider } from './notification-email.service';
import { EmailDeliveryWorker } from './email-delivery.worker';

@Module({
  imports: [AuthModule, MlModule],
  controllers: [WorkflowsController],
  providers: [NotificationEmailService, mailTransportFactoryProvider, EmailDeliveryWorker],
  exports: [NotificationEmailService],
})
export class WorkflowsModule {}
