import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcademicController } from './academic.controller';
import { AcademicSummaryService } from './academic-summary.service';
import { GradingService } from './grading.service';

@Module({
  imports: [AuthModule],
  controllers: [AcademicController],
  providers: [GradingService, AcademicSummaryService],
  exports: [GradingService, AcademicSummaryService],
})
export class AcademicModule {}
