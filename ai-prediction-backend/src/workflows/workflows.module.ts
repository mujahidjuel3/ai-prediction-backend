import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MlModule } from '../ml/ml.module';
import { WorkflowsController } from './workflows.controller';
import {
  NotificationEmailService,
  brevoFetchProvider,
  mailTransportFactoryProvider,
  resendClientFactoryProvider,
} from './notification-email.service';
import { EmailDeliveryWorker } from './email-delivery.worker';
import { NotificationGateway } from './notification.gateway';
import { DemoPredictionService } from './demo-prediction.service';

@Module({
  imports: [AuthModule, MlModule],
  controllers: [WorkflowsController],
  providers: [
    NotificationEmailService,
    mailTransportFactoryProvider,
    brevoFetchProvider,
    resendClientFactoryProvider,
    EmailDeliveryWorker,
    NotificationGateway,
    DemoPredictionService,
  ],
  exports: [NotificationEmailService, NotificationGateway, DemoPredictionService],
})
export class WorkflowsModule {}
