import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcademicController } from './academic.controller';
import { GradingService } from './grading.service';

@Module({
  imports: [AuthModule],
  controllers: [AcademicController],
  providers: [GradingService],
  exports: [GradingService],
})
export class AcademicModule {}
