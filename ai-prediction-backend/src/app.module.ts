import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import * as Joi from 'joi';
import { AcademicModule } from './academic/academic.module';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { CsrfGuard } from './common/guards/csrf.guard';
import { HealthController } from './prisma/prisma-health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { StudentsModule } from './students/students.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { InstitutionModule } from './institution/institution.module';
import { ImportsModule } from './imports/imports.module';
import { ReportsModule } from './reports/reports.module';
import { LoggerModule } from 'nestjs-pino';

export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  DATABASE_URL: Joi.string().required(),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('10m'),
  REFRESH_TOKEN_TTL_DAYS: Joi.number().integer().min(1).max(90).default(14),
  COOKIE_SECURE: Joi.when('NODE_ENV', { is: 'production', then: Joi.boolean().valid(true).required(), otherwise: Joi.boolean().default(false) }),
  COOKIE_SAME_SITE: Joi.string().valid('lax', 'strict', 'none').default('lax'),
  CORS_ORIGINS: Joi.string().required().custom((value, helpers) => {
    const origins = value.split(',').map((origin: string) => origin.trim()).filter(Boolean);
    if (!origins.length || origins.length !== new Set(origins).size) return helpers.error('any.invalid');
    const isProduction = (helpers.state.ancestors[0] as { NODE_ENV?: string } | undefined)?.NODE_ENV === 'production' || process.env.NODE_ENV === 'production';
    if (origins.some((origin: string) => {
      try {
        const parsed = new URL(origin);
        if (parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return true;
        if (isProduction) {
          return parsed.protocol !== 'https:' || !['www.academicsentinel.live', 'admin.academicsentinel.live'].includes(parsed.hostname);
        }
        return parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname);
      } catch { return true; }
    })) return helpers.error('any.invalid');
    if (isProduction && origins.length !== 2) return helpers.error('any.invalid');
    return value;
  }, 'validated frontend origins'),
  ML_SERVICE_URL: Joi.when('NODE_ENV', { is: 'production', then: Joi.string().uri().required(), otherwise: Joi.string().uri().default('http://127.0.0.1:8000') }),
  ML_SERVICE_TOKEN: Joi.string().min(32).required(),
  STUDENT_PREDICTIONS_ENABLED: Joi.boolean().default(false),
  EMAIL_POLICY_APPROVED: Joi.boolean().default(false),
  SMTP_ENABLED: Joi.boolean().default(false).when('EMAIL_POLICY_APPROVED', { is: false, then: Joi.valid(false) }),
  SMTP_HOST: Joi.string().hostname().default('smtp.gmail.com'),
  SMTP_PORT: Joi.number().port().default(465),
  SMTP_SECURE: Joi.boolean().default(true),
  SMTP_USER: Joi.when('SMTP_ENABLED', { is: true, then: Joi.string().email().required(), otherwise: Joi.string().allow('').optional() }),
  SMTP_PASSWORD: Joi.when('SMTP_ENABLED', { is: true, then: Joi.string().min(1).required(), otherwise: Joi.string().allow('').optional() }),
  SMTP_FROM: Joi.when('SMTP_ENABLED', { is: true, then: Joi.string().email().required(), otherwise: Joi.string().allow('').optional() }),
});

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validationSchema: environmentSchema }),
    LoggerModule.forRoot({ pinoHttp: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug', redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'], censor: '[REDACTED]' } } }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    StudentsModule,
    AcademicModule,
    WorkflowsModule,
    InstitutionModule,
    ImportsModule,
    ReportsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
