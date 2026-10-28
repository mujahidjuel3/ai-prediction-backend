import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

class LoginDto { @IsEmail() email!: string; @IsString() @MinLength(1) password!: string; }
@ApiTags('auth') @Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  private cookie(res: Response, access: string, refresh: string) {
    const secure = process.env.COOKIE_SECURE === 'true';
    res.cookie('access_token', access, { httpOnly: true, secure, sameSite: (process.env.COOKIE_SAME_SITE as 'lax'|'strict'|'none') ?? 'lax', path: '/', maxAge: 10 * 60 * 1000 });
    res.cookie('refresh_token', refresh, { httpOnly: true, secure, sameSite: (process.env.COOKIE_SAME_SITE as 'lax'|'strict'|'none') ?? 'lax', path: '/api/v1/auth', maxAge: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 14) * 86400000 });
    res.cookie('csrf_token', randomBytes(32).toString('base64url'), { httpOnly: false, secure, sameSite: (process.env.COOKIE_SAME_SITE as 'lax'|'strict'|'none') ?? 'lax', path: '/' });
  }
  @Public() @Get('csrf') csrf(@Res({ passthrough: true }) res: Response) { const token=randomBytes(32).toString('base64url');res.cookie('csrf_token',token,{httpOnly:false,secure:process.env.COOKIE_SECURE==='true',sameSite:(process.env.COOKIE_SAME_SITE as 'lax'|'strict'|'none')??'lax',path:'/'});return{data:{csrfToken:token}}; }
  @Public() @Throttle({default:{limit:5,ttl:60000}}) @Post('login') async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) { const s = await this.auth.login(dto.email, dto.password); this.cookie(res, s.access, s.refresh); return { data: { user: s.user } }; }
  @Public() @Throttle({default:{limit:10,ttl:60000}}) @Post('refresh') async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) { const raw = req.cookies?.refresh_token; if (!raw) return this.auth.refresh(''); const s = await this.auth.refresh(raw); this.cookie(res, s.access, s.refresh); return { data: { user: s.user } }; }
  @UseGuards(JwtAuthGuard) @Post('logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) { await this.auth.logout(req.cookies?.refresh_token); res.clearCookie('access_token', { path: '/' }); res.clearCookie('refresh_token', { path: '/api/v1/auth' }); res.clearCookie('csrf_token',{path:'/'}); return { data: { loggedOut: true } }; }
  @UseGuards(JwtAuthGuard) @Get('me') async me(@CurrentUser() user: AuthUser) { return { data: await this.auth.me(user.id) }; }
}
