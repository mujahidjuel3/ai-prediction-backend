/**
 * Disposable isolated-database verification for Neon-oriented Prisma config.
 *
 * - Creates academic_sentinel_neon_iso (sibling of DATABASE_URL)
 * - Applies existing migrations via migrate deploy (DIRECT_URL)
 * - Exercises Prisma Client against a pooled-style DATABASE_URL (connection_limit)
 * - Runs synthetic CRUD / auth-session / account-linking / notification persistence
 * - Drops the isolated database
 *
 * Does NOT: migrate reset, db push, touch production, or mutate academic_sentinel rows.
 * Neon CLI branch API is optional; local isolated Postgres is the default stand-in.
 */
import { config } from 'dotenv';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
config({ path: resolve(root, '.env') });

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const isolatedName = 'academic_sentinel_neon_iso';
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';

function buildUrls() {
  const pooled = new URL(sourceUrl);
  pooled.pathname = `/${isolatedName}`;
  pooled.searchParams.set('schema', 'public');
  pooled.searchParams.set('connection_limit', '5');

  const direct = new URL(sourceUrl);
  direct.pathname = `/${isolatedName}`;
  direct.searchParams.set('schema', 'public');
  direct.searchParams.delete('connection_limit');
  direct.searchParams.delete('pgbouncer');

  return { pooled: pooled.toString(), direct: direct.toString() };
}

async function recreateIsolatedDatabase() {
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [isolatedName]);
  if (existing.rowCount) {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [isolatedName],
    );
    await admin.query(`DROP DATABASE ${isolatedName}`);
  }
  await admin.query(`CREATE DATABASE ${isolatedName}`);
  await admin.end();
  console.log(`Created isolated database ${isolatedName}`);
}

async function dropIsolatedDatabase() {
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [isolatedName],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${isolatedName}`);
  await admin.end();
  console.log(`Dropped isolated database ${isolatedName}`);
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runPersistenceSuite(pooledUrl) {
  const { PrismaClient, Role, AccountStatus, EmailDeliveryStatus } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasources: { db: { url: pooledUrl } },
    log: ['error', 'warn'],
  });

  const suffix = randomUUID().slice(0, 8);
  const adminEmail = `neon-admin-${suffix}@academic-sentinel.local`;
  const studentEmail = `neon-student-${suffix}@academic-sentinel.local`;
  const refreshHash = createHash('sha256').update(`refresh-${suffix}`).digest('hex');

  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    console.log('PASS health SELECT 1');

    const applied = await prisma.$queryRaw`
      SELECT migration_name FROM "_prisma_migrations" ORDER BY finished_at ASC NULLS LAST, migration_name ASC
    `;
    const names = applied.map((row) => row.migration_name);
    assert(names.includes('20261026120000_initial'), 'missing initial migration');
    assert(names.includes('20261028153000_notification_email_delivery'), 'missing email delivery migration');
    console.log(`PASS migration history (${names.length} applied)`);

    const admin = await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Neon Iso Admin',
        role: Role.ADMIN,
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$bmVvbg$bmVvbg',
        status: AccountStatus.ACTIVE,
      },
    });
    console.log('PASS auth user create');

    await prisma.authSession.create({
      data: {
        userId: admin.id,
        refreshTokenHash: refreshHash,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    console.log('PASS auth session persistence');

    await prisma.$transaction(async (tx) => {
      await tx.authSession.update({
        where: { refreshTokenHash: refreshHash },
        data: { revokedAt: new Date() },
      });
      await tx.authSession.create({
        data: {
          userId: admin.id,
          refreshTokenHash: createHash('sha256').update(`refresh-rotated-${suffix}`).digest('hex'),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    });
    console.log('PASS auth refresh rotation transaction');

    const department = await prisma.department.create({
      data: { code: `NEON${suffix.slice(0, 4).toUpperCase()}`, name: `Neon Dept ${suffix}` },
    });

    const linked = await prisma.$transaction(async (tx) => {
      const login = await tx.user.create({
        data: {
          email: studentEmail,
          name: 'Neon Iso Student',
          role: Role.STUDENT,
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c3R1ZA$c3R1ZA',
          status: AccountStatus.ACTIVE,
        },
      });
      return tx.student.create({
        data: {
          studentNumber: `NEON-${suffix}`,
          name: 'Neon Iso Student',
          email: studentEmail,
          departmentId: department.id,
          enrollmentYear: 2026,
          userId: login.id,
          status: AccountStatus.ACTIVE,
        },
        include: { user: { select: { id: true, email: true, role: true } } },
      });
    });
    assert(linked.user?.role === 'STUDENT', 'account link role mismatch');
    console.log('PASS account linking transaction');

    const notification = await prisma.$transaction(async (tx) => {
      const created = await tx.notification.create({
        data: {
          recipientId: linked.userId,
          title: 'Neon isolated notice',
          message: 'Synthetic notification for Neon isolation test',
          inAppVisible: true,
          idempotencyKey: `neon-iso-${suffix}`,
        },
      });
      await tx.notificationEmailDelivery.create({
        data: {
          notificationId: created.id,
          status: EmailDeliveryStatus.PENDING,
        },
      });
      await tx.notificationPreference.upsert({
        where: { userId: linked.userId },
        create: { userId: linked.userId, inApp: true, email: false, categories: {} },
        update: { inApp: true, email: false },
      });
      return created;
    });

    const delivery = await prisma.notificationEmailDelivery.findUnique({
      where: { notificationId: notification.id },
    });
    assert(delivery?.status === 'PENDING', 'notification email delivery missing');
    console.log('PASS notification + email delivery persistence');

    let rolledBack = false;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.department.create({
          data: { code: `RB${suffix.slice(0, 4).toUpperCase()}`, name: `Rollback ${suffix}` },
        });
        throw new Error('forced_rollback');
      });
    } catch (cause) {
      rolledBack = cause instanceof Error && cause.message === 'forced_rollback';
    }
    assert(rolledBack, 'transaction did not throw');
    const leftover = await prisma.department.findFirst({ where: { name: `Rollback ${suffix}` } });
    assert(!leftover, 'transaction rollback leaked rows');
    console.log('PASS transaction rollback');

    await prisma.$disconnect();
    console.log('PASS prisma disconnect cleanup');
  } catch (cause) {
    await prisma.$disconnect().catch(() => undefined);
    throw cause;
  }
}

const { pooled, direct } = buildUrls();

try {
  await recreateIsolatedDatabase();

  console.log('Generating Prisma Client...');
  run('npx', ['prisma', 'generate'], { DATABASE_URL: pooled, DIRECT_URL: direct });

  console.log('Deploying existing migrations to isolated database...');
  run('npx', ['prisma', 'migrate', 'deploy'], { DATABASE_URL: pooled, DIRECT_URL: direct });

  const verify = new Client({ connectionString: direct });
  await verify.connect();
  const tables = await verify.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name IN ('User','Student','Notification','NotificationEmailDelivery','_prisma_migrations')
    ORDER BY table_name
  `);
  await verify.end();
  assert(tables.rowCount === 5, `expected core tables, found ${tables.rowCount}`);
  console.log('PASS schema tables present after migrate deploy');

  await runPersistenceSuite(pooled);
  console.log('Isolated Neon-style verification OK');
} catch (cause) {
  console.error('Isolated Neon-style verification FAILED');
  console.error(cause instanceof Error ? cause.message : cause);
  try {
    await dropIsolatedDatabase();
  } catch {
    /* ignore cleanup failure after primary error */
  }
  process.exit(1);
}

await dropIsolatedDatabase();
process.exit(0);
