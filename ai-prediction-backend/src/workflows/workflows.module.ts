import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkflowsController } from './workflows.controller';
import { NotificationEmailService, mailTransportFactoryProvider } from './notification-email.service';
@Module({imports:[AuthModule],controllers:[WorkflowsController],providers:[NotificationEmailService,mailTransportFactoryProvider]}) export class WorkflowsModule{}
