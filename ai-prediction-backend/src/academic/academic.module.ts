import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcademicController } from './academic.controller';
@Module({ imports: [AuthModule], controllers: [AcademicController] }) export class AcademicModule {}
