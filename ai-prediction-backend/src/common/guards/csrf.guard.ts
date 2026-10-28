import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { timingSafeEqual } from 'node:crypto';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    if (!['POST','PATCH','PUT','DELETE'].includes(req.method) || req.headers.authorization) return true;
    const cookie = req.cookies?.csrf_token; const header = req.headers['x-csrf-token'];
    const allowedOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map((v:string)=>v.trim());
    if (req.headers.origin && !allowedOrigins.includes(req.headers.origin)) throw new ForbiddenException('Request origin is not allowed');
    if (typeof cookie !== 'string' || typeof header !== 'string') throw new ForbiddenException('CSRF token required');
    const a=Buffer.from(cookie); const b=Buffer.from(header);
    if (a.length!==b.length || !timingSafeEqual(a,b)) throw new ForbiddenException('Invalid CSRF token');
    return true;
  }
}
