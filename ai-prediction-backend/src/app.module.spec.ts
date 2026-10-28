import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule, environmentSchema } from './app.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PrismaService } from './prisma/prisma.module';

describe('AppModule authentication wiring', () => {
  it('requires approved email policy and complete server settings before SMTP can be enabled', () => {
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost/test',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      CORS_ORIGINS: 'http://localhost:3000',
      ML_SERVICE_TOKEN: 'y'.repeat(32),
    };
    expect(environmentSchema.validate({ ...base, SMTP_ENABLED: true, EMAIL_POLICY_APPROVED: false }).error).toBeDefined();
    expect(environmentSchema.validate({ ...base, SMTP_ENABLED: false, EMAIL_POLICY_APPROVED: false }).error).toBeUndefined();
    expect(environmentSchema.validate({ ...base, SMTP_ENABLED: true, EMAIL_POLICY_APPROVED: true, SMTP_USER: 'sender@example.com', SMTP_PASSWORD: 'synthetic-test-password', SMTP_FROM: 'sender@example.com' }).error).toBeUndefined();
  });

  it('resolves the shared JWT guard and JwtService across guarded modules', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    expect(moduleRef.get(JwtAuthGuard, { strict: false })).toBeInstanceOf(JwtAuthGuard);
    expect(moduleRef.get(JwtService, { strict: false })).toBeInstanceOf(JwtService);

    await moduleRef.close();
  });

  describe('role guard order on an Admin-only route', () => {
    let app: INestApplication;
    let moduleRef: Awaited<ReturnType<typeof createApplication>>;
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'role-test@academic-sentinel.local',
      status: 'ACTIVE',
      role: 'ADMIN' as 'ADMIN' | 'TEACHER',
    };

    async function createApplication() {
      const prisma = {
        $transaction: jest.fn((operations: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => typeof operations === 'function' ? operations(prisma) : Promise.all(operations)),
        notification: {
          create: jest.fn(async ({ data }: { data: { recipientId: string; title: string; message: string } }) => ({ id: '22222222-2222-4222-8222-222222222222', ...data, readAt: null })),
          findUnique: jest.fn(async () => null),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        notificationEmailDelivery: {
          findUnique: jest.fn(async () => ({ id: '33333333-3333-4333-8333-333333333333', notificationId: '22222222-2222-4222-8222-222222222222', status: 'PENDING', attemptCount: 0, providerMessageId: null, lastErrorCode: null, acceptedAt: null, notification: { title: 'Manual notice', message: 'Persisted in-app message', recipient: { email: user.email, preference: { email: false } } } })),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
          update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: '33333333-3333-4333-8333-333333333333', status: data.status, attemptCount: data.attemptCount ?? 0, providerMessageId: data.providerMessageId ?? null, lastErrorCode: data.lastErrorCode ?? null, acceptedAt: data.acceptedAt ?? null })),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        user: {
          findUnique: jest.fn(async () => ({ ...user })),
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        teacher: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
        student: { count: jest.fn().mockResolvedValue(0) },
        department: { count: jest.fn().mockResolvedValue(0) },
        course: { count: jest.fn().mockResolvedValue(0) },
        courseOffering: { count: jest.fn().mockResolvedValue(0) },
        riskAlert: { count: jest.fn().mockResolvedValue(0) },
      };
      const testingModule = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();
      const testApp = testingModule.createNestApplication();
      testApp.use(cookieParser());
      testApp.setGlobalPrefix('api/v1');
      testApp.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await testApp.init();
      return { testingModule, testApp };
    }

    beforeEach(async () => {
      const created = await createApplication();
      moduleRef = created;
      app = created.testApp;
    });

    afterEach(async () => {
      await app.close();
    });

    async function accessToken(role: 'ADMIN' | 'TEACHER') {
      user.role = role;
      return moduleRef.testingModule.get(JwtService).signAsync({ sub: user.id, email: user.email, role });
    }

    it('allows an active Admin to access the Admin-only users endpoint', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', `access_token=${token}`)
        .expect(200);
    });

    it('denies an active Teacher access to the Admin-only users endpoint', async () => {
      const token = await accessToken('TEACHER');
      await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', `access_token=${token}`)
        .expect(403)
        .expect(({ body }) => expect(body.message).toBe('Insufficient role'));
    });

    it('uses pagination defaults when list query parameters are omitted', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer()).get('/api/v1/teachers').set('Cookie', `access_token=${token}`).expect(200);
    });

    it('allows an Admin to load database-backed dashboard summary counts', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .get('/api/v1/dashboard/summary')
        .set('Cookie', `access_token=${token}`)
        .expect(200)
        .expect(({ body }) => expect(body.data).toMatchObject({ students: 0, departments: 0, teachers: 0, courses: 0, offerings: 0 }));
    });

    it('accepts canonical pagination parameters and rejects duplicated query keys', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .get('/api/v1/teachers?page=1&pageSize=100')
        .set('Cookie', `access_token=${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/teachers?page=1&pageSize=100&page=1&pageSize=100')
        .set('Cookie', `access_token=${token}`)
        .expect(400);
    });

    it('accepts matching CSRF cookie and header for an Admin notification mutation', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .post('/api/v1/notifications')
        .set('Idempotency-Key', 'manual-message-test-001')
        .set('Cookie', `access_token=${token}; csrf_token=csrf-test-value`)
        .set('X-CSRF-Token', 'csrf-test-value')
        .send({ recipientId: user.id, title: 'Manual notice', message: 'Persisted in-app message' })
        .expect(201)
        .expect(({ body }) => {
          expect(body.data.notification.title).toBe('Manual notice');
          expect(body.data.emailDelivery.status).toBe('SUPPRESSED_PREFERENCE');
        });
    });

    it('requires a stable idempotency key for manual message creation', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .post('/api/v1/notifications')
        .set('Cookie', `access_token=${token}; csrf_token=csrf-test-value`)
        .set('X-CSRF-Token', 'csrf-test-value')
        .send({ recipientId: user.id, title: 'Manual notice', message: 'Persisted in-app message' })
        .expect(400);
    });

    it('restricts email delivery history to Admins', async () => {
      const adminToken = await accessToken('ADMIN');
      await request(app.getHttpServer()).get('/api/v1/notifications/email-deliveries').set('Cookie', `access_token=${adminToken}`).expect(200);
      const teacherToken = await accessToken('TEACHER');
      await request(app.getHttpServer()).get('/api/v1/notifications/email-deliveries').set('Cookie', `access_token=${teacherToken}`).expect(403);
    });

    it('rejects a mismatched CSRF token', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .post('/api/v1/notifications')
        .set('Idempotency-Key', 'manual-message-test-002')
        .set('Cookie', `access_token=${token}; csrf_token=cookie-token`)
        .set('X-CSRF-Token', 'different-token')
        .send({ recipientId: user.id, title: 'Manual notice', message: 'Persisted in-app message' })
        .expect(403)
        .expect(({ body }) => expect(body.message).toBe('Invalid CSRF token'));
    });

    it('rejects malformed notification payloads with validation errors', async () => {
      const token = await accessToken('ADMIN');
      await request(app.getHttpServer())
        .post('/api/v1/notifications')
        .set('Idempotency-Key', 'manual-message-test-003')
        .set('Cookie', `access_token=${token}; csrf_token=csrf-test-value`)
        .set('X-CSRF-Token', 'csrf-test-value')
        .send({ recipientId: 'not-a-uuid', title: '', message: 'Message' })
        .expect(400);
    });

    it('rejects a validly signed but expired access token', async () => {
      const token = await moduleRef.testingModule.get(JwtService).signAsync(
        { sub: user.id, email: user.email, role: 'ADMIN' },
        { expiresIn: '-1s' },
      );
      await request(app.getHttpServer()).get('/api/v1/users').set('Cookie', `access_token=${token}`).expect(401);
    });

    it('denies a Teacher from creating an Admin-only notification', async () => {
      const token = await accessToken('TEACHER');
      await request(app.getHttpServer())
        .post('/api/v1/notifications')
        .set('Cookie', `access_token=${token}; csrf_token=csrf-test-value`)
        .set('X-CSRF-Token', 'csrf-test-value')
        .send({ recipientId: user.id, title: 'Manual notice', message: 'Persisted in-app message' })
        .expect(403);
    });

    it('denies a Teacher from provisioning or linking a Student account', async () => {
      const token = await accessToken('TEACHER');
      const csrfCookie = 'csrf_token=csrf-test-value';
      await request(app.getHttpServer())
        .post('/api/v1/students')
        .set('Cookie', `access_token=${token}; ${csrfCookie}`)
        .set('X-CSRF-Token', 'csrf-test-value')
        .send({ accountMode: 'CREATE', email: 'student-test@example.test', initialPassword: 'local-test-temporary-password', studentNumber: 'ST-TEST-1', name: 'Synthetic Student', departmentId: '11111111-1111-4111-8111-111111111111', enrollmentYear: 2026 })
        .expect(403);
      await request(app.getHttpServer())
        .post('/api/v1/students/22222222-2222-4222-8222-222222222222/link-account')
        .set('Cookie', `access_token=${token}; ${csrfCookie}`)
        .set('X-CSRF-Token', 'csrf-test-value')
        .send({ accountMode: 'LINK', userId: '33333333-3333-4333-8333-333333333333' })
        .expect(403);
    });
  });
});
