import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InstitutionController } from './institution.controller';
@Module({imports:[AuthModule],controllers:[InstitutionController]}) export class InstitutionModule{}
