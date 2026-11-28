import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AcademicController } from './academic.controller';
import { AcademicSummaryService } from './academic-summary.service';

@Module({
  imports: [AuthModule],
  controllers: [AcademicController],
  providers: [AcademicSummaryService],
})
export class AcademicModule {}
