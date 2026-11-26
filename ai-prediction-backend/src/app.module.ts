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
import { MlModule } from './ml/ml.module';
import { LoggerModule } from 'nestjs-pino';

export const environmentSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  /** Neon pooled (or local) runtime URL used by Prisma Client. */
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
  /**
   * Neon direct (non-pooler) URL for Prisma Migrate. Required in production.
   * Local/dev may set DIRECT_URL equal to DATABASE_URL when no pooler is used.
   */
  DIRECT_URL: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),
    otherwise: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).optional(),
  }),
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
  /**
   * When false, Nest boots without requiring a live ML service (demo/local/API-only).
   * URL and token are required only when ML_INTEGRATION_ENABLED=true.
   */
  ML_INTEGRATION_ENABLED: Joi.boolean().default(false),
  ML_SERVICE_URL: Joi.when('ML_INTEGRATION_ENABLED', {
    is: true,
    then: Joi.string().uri().required(),
    otherwise: Joi.string().uri().allow('').optional().default('http://127.0.0.1:8000'),
  }),
  ML_SERVICE_TOKEN: Joi.when('ML_INTEGRATION_ENABLED', {
    is: true,
    then: Joi.string().min(32).required(),
    otherwise: Joi.string().min(32).allow('').optional().default('ml-integration-disabled-placeholder-token'),
  }),
  ML_SERVICE_TIMEOUT_MS: Joi.number().integer().min(250).max(60000).default(3000),
  ML_SERVICE_RETRIES: Joi.number().integer().min(0).max(3).default(2),
  STUDENT_PREDICTIONS_ENABLED: Joi.boolean().default(false),
  /** Explicit university gate. Remains false until dataset/target/horizon/thresholds/features/review/consent are approved. */
  ML_UNIVERSITY_POLICY_APPROVED: Joi.boolean().default(false),
  /** Must stay false unless a non-synthetic validated/production artifact is approved for student-facing use. */
  ML_PREDICTION_PERSISTENCE_ENABLED: Joi.boolean().default(false),
  /**
   * Demo-only: allows Admin to run synthetic ML inference and persist clearly labeled DEMO/SYNTHETIC predictions.
   * Never enables production POST /predictions/generate.
   */
  DEMO_PREDICTION_ENABLED: Joi.boolean().default(false),
  /** Comma-separated emails allowed for Admin-triggered test messages. Empty = test email disabled. */
  EMAIL_TEST_RECIPIENTS: Joi.string().allow('').default(''),
  STUDENT_SELF_REGISTRATION_ENABLED: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),
  TEACHER_SELF_REGISTRATION_ENABLED: Joi.boolean().default(false),
  EMAIL_POLICY_APPROVED: Joi.boolean().default(false),
  /** Outbound transport master switch. Still requires EMAIL_POLICY_APPROVED=true to enable. */
  SMTP_ENABLED: Joi.boolean().default(false).when('EMAIL_POLICY_APPROVED', { is: false, then: Joi.valid(false) }),
  /** smtp = Nodemailer (default, local-compatible). brevo = Brevo Transactional Email API. */
  EMAIL_PROVIDER: Joi.string().valid('smtp', 'brevo').default('smtp'),
  SMTP_HOST: Joi.string().hostname().default('smtp.gmail.com'),
  SMTP_PORT: Joi.number().port().default(465),
  SMTP_SECURE: Joi.boolean().default(true),
  SMTP_USER: Joi.when('SMTP_ENABLED', {
    is: true,
    then: Joi.when('EMAIL_PROVIDER', {
      is: 'brevo',
      then: Joi.string().email().allow('').optional(),
      otherwise: Joi.string().email().required(),
    }),
    otherwise: Joi.string().allow('').optional(),
  }),
  /** Preferred Gmail App Password env name. */
  SMTP_PASS: Joi.string().allow('').optional(),
  /** Legacy alias for SMTP_PASS. */
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  SMTP_FROM: Joi.when('SMTP_ENABLED', {
    is: true,
    then: Joi.when('EMAIL_PROVIDER', {
      is: 'brevo',
      then: Joi.string().email().allow('').optional(),
      otherwise: Joi.string().email().required(),
    }),
    otherwise: Joi.string().allow('').optional(),
  }),
  SMTP_FROM_NAME: Joi.string().allow('').default('Academic Sentinel'),
  BREVO_API_KEY: Joi.string().allow('').optional(),
  BREVO_SENDER_EMAIL: Joi.string().email().allow('').optional(),
  BREVO_SENDER_NAME: Joi.string().max(160).allow('').default('Academic Sentinel'),
  BREVO_TIMEOUT_MS: Joi.number().integer().min(1_000).max(60_000).default(15_000),
  EMAIL_WORKER_ENABLED: Joi.boolean().default(true),
  EMAIL_WORKER_INTERVAL_MS: Joi.number().integer().min(5_000).max(600_000).default(15_000),
  EMAIL_WORKER_BATCH_SIZE: Joi.number().integer().min(1).max(50).default(10),
  EMAIL_WORKER_AUTO_RETRY: Joi.boolean().default(false),
  EMAIL_MAX_ATTEMPTS: Joi.number().integer().min(1).max(5).default(3),
  EMAIL_MAX_DISPATCH_ROUNDS: Joi.number().integer().min(1).max(5).default(2),
  EMAIL_RETRY_BACKOFF_MS: Joi.number().integer().min(5_000).max(3_600_000).default(60_000),
  EMAIL_STALE_SENDING_MS: Joi.number().integer().min(60_000).max(3_600_000).default(300_000),
}).custom((value, helpers) => {
  if (!value.SMTP_ENABLED) return value;
  if (value.EMAIL_PROVIDER === 'brevo') {
    if (!value.BREVO_API_KEY) {
      return helpers.error('any.custom', { message: 'BREVO_API_KEY is required when EMAIL_PROVIDER=brevo and SMTP_ENABLED=true' });
    }
    if (!value.BREVO_SENDER_EMAIL) {
      return helpers.error('any.custom', { message: 'BREVO_SENDER_EMAIL is required when EMAIL_PROVIDER=brevo and SMTP_ENABLED=true' });
    }
    return value;
  }
  if (!(value.SMTP_PASS || value.SMTP_PASSWORD)) {
    return helpers.error('any.custom', { message: 'SMTP_PASS or SMTP_PASSWORD is required when SMTP_ENABLED=true and EMAIL_PROVIDER=smtp' });
  }
  return value;
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
    MlModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
