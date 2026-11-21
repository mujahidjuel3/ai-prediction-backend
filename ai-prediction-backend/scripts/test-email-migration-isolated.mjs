/**
 * Applies prisma migrations to an isolated sibling database, then exits.
 * Does not drop or reset the primary DATABASE_URL database.
 */
import { config } from 'dotenv';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
config({ path: resolve(root, '.env') });

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const parsed = new URL(sourceUrl);
const isolatedName = 'academic_sentinel_email_migtest';
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';
const isolatedUrl = new URL(sourceUrl);
isolatedUrl.pathname = `/${isolatedName}`;

const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [isolatedName]);
if (existing.rowCount) {
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [isolatedName]);
  await admin.query(`DROP DATABASE ${isolatedName}`);
}
await admin.query(`CREATE DATABASE ${isolatedName}`);
await admin.end();

console.log(`Created isolated database ${isolatedName}`);
const deploy = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  cwd: root,
  env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
  encoding: 'utf8',
  shell: true,
});
process.stdout.write(deploy.stdout || '');
process.stderr.write(deploy.stderr || '');
if (deploy.status !== 0) {
  console.error('Isolated migrate deploy failed');
  process.exit(deploy.status || 1);
}

const verify = new Client({ connectionString: isolatedUrl.toString() });
await verify.connect();
const enumCheck = await verify.query(`SELECT 1 FROM pg_type WHERE typname = 'EmailDeliveryStatus'`);
const tableCheck = await verify.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'NotificationEmailDelivery'`);
const columnCheck = await verify.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Notification' AND column_name IN ('idempotencyKey','inAppVisible')`);
await verify.end();

if (!enumCheck.rowCount || !tableCheck.rowCount || columnCheck.rowCount < 2) {
  console.error('Isolated migration verification failed');
  process.exit(1);
}

console.log('Isolated migration verification OK: EmailDeliveryStatus, NotificationEmailDelivery, Notification.idempotencyKey/inAppVisible');
process.exit(0);
