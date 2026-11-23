import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MlModule } from '../ml/ml.module';
import { WorkflowsController } from './workflows.controller';
import { NotificationEmailService, brevoFetchProvider, mailTransportFactoryProvider } from './notification-email.service';
import { EmailDeliveryWorker } from './email-delivery.worker';
import { NotificationGateway } from './notification.gateway';

@Module({
  imports: [AuthModule, MlModule],
  controllers: [WorkflowsController],
  providers: [NotificationEmailService, mailTransportFactoryProvider, brevoFetchProvider, EmailDeliveryWorker, NotificationGateway],
  exports: [NotificationEmailService, NotificationGateway],
})
export class WorkflowsModule {}
