import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 6.19 classic engine — no Neon serverless adapter required for Nest on Azure App Service.
 * DATABASE_URL should be the pooled Neon connection string at runtime.
 * DIRECT_URL is used by Prisma Migrate (schema directUrl), not by this client.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const datasourceUrl = process.env.DATABASE_URL;
    super({
      datasources: datasourceUrl ? { db: { url: datasourceUrl } } : undefined,
      log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log({ event: 'prisma_connected' });
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log({ event: 'prisma_disconnected' });
  }
}

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
