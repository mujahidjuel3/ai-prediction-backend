import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/prisma/prisma.module';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('The local bootstrap script is disabled in production');
  const prisma = new PrismaClient();
  try {
    const service = new AuthService(prisma as unknown as PrismaService, new JwtService());
    const user = await service.bootstrapAdmin(process.env.BOOTSTRAP_ADMIN_EMAIL ?? '', process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '', process.env.BOOTSTRAP_ADMIN_NAME ?? '');
    process.stdout.write(`Created initial administrator ${user.email} (${user.id}).\n`);
  } finally { await prisma.$disconnect(); }
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
