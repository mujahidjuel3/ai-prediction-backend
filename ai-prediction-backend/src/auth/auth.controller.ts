import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  accessTokenCookieOptions,
  clearAccessTokenCookieOptions,
  clearCsrfTokenCookieOptions,
  clearRefreshTokenCookieOptions,
  csrfTokenCookieOptions,
  refreshTokenCookieOptions,
} from './auth-cookie';

class LoginDto { @IsEmail() email!: string; @IsString() @MinLength(1) password!: string; }
class RegisterDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(14) @MaxLength(128) password!: string;
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
  /** Only STUDENT or TEACHER. ADMIN is rejected by the service. Defaults to STUDENT. */
  @IsOptional() @IsEnum(Role) role?: Role;
}
@ApiTags('auth') @Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  private cookie(res: Response, access: string, refresh: string) {
    res.cookie('access_token', access, accessTokenCookieOptions());
    res.cookie('refresh_token', refresh, refreshTokenCookieOptions());
    res.cookie('csrf_token', randomBytes(32).toString('base64url'), csrfTokenCookieOptions());
  }
  @Public() @Get('csrf') csrf(@Res({ passthrough: true }) res: Response) {
    const token = randomBytes(32).toString('base64url');
    res.cookie('csrf_token', token, csrfTokenCookieOptions());
    return { data: { csrfToken: token } };
  }
  @Public() @Throttle({default:{limit:5,ttl:60000}}) @Post('login') async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) { const s = await this.auth.login(dto.email, dto.password); this.cookie(res, s.access, s.refresh); return { data: { user: s.user } }; }
  @Public() @Throttle({default:{limit:5,ttl:60000}}) @Post('register') async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.register({ email: dto.email, password: dto.password, name: dto.name, role: dto.role ?? Role.STUDENT });
    this.cookie(res, s.access, s.refresh);
    return { data: { user: s.user } };
  }
  @Public() @Throttle({default:{limit:10,ttl:60000}}) @Post('refresh') async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) { const raw = req.cookies?.refresh_token; if (!raw) return this.auth.refresh(''); const s = await this.auth.refresh(raw); this.cookie(res, s.access, s.refresh); return { data: { user: s.user } }; }
  @UseGuards(JwtAuthGuard) @Post('logout') async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.refresh_token);
    res.clearCookie('access_token', clearAccessTokenCookieOptions());
    res.clearCookie('refresh_token', clearRefreshTokenCookieOptions());
    res.clearCookie('csrf_token', clearCsrfTokenCookieOptions());
    return { data: { loggedOut: true } };
  }
  @UseGuards(JwtAuthGuard) @Get('me') async me(@CurrentUser() user: AuthUser) { return { data: await this.auth.me(user.id) }; }
}
