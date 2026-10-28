import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportsController } from './imports.controller';
@Module({imports:[AuthModule],controllers:[ImportsController]}) export class ImportsModule{}
