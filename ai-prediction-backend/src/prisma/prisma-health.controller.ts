import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from './prisma.module';
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}
  @Public() @Get('live') live() { return { data: { status: 'ok' } }; }
  @Public() @Get('ready') async ready() { await this.prisma.$queryRaw`SELECT 1`; return { data: { status: 'ready' } }; }
}
