import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.module';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private jwt: JwtService, private prisma: PrismaService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest();
    const token = req.cookies?.access_token ?? req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new UnauthorizedException('Authentication required');
    try {
      const claims = await this.jwt.verifyAsync<{ sub: string; email: string; role: string }>(token);
      const user = await this.prisma.user.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, role: true, status: true } });
      if (!user || user.status !== 'ACTIVE' || user.role !== claims.role) throw new Error('inactive');
      req.user = { id: user.id, email: user.email, role: user.role };
      return true;
    } catch { throw new UnauthorizedException('Invalid or expired credentials'); }
  }
}
