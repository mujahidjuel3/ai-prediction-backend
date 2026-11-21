import { Injectable, UnauthorizedException, ConflictException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}
  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || user.status !== 'ACTIVE' || !(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException('Invalid email or password');
    return this.issue(user.id, user.email, user.role);
  }
  /** Public self-registration creates a login account only. Academic profiles still require Admin linking. Never creates ADMIN. */
  async register(input: { email: string; password: string; name: string; role: Role }) {
    if (input.role !== Role.STUDENT && input.role !== Role.TEACHER) {
      throw new ForbiddenException('Administrator accounts cannot be self-registered');
    }
    const studentRegistrationEnabled = process.env.STUDENT_SELF_REGISTRATION_ENABLED === 'true'
      || (process.env.STUDENT_SELF_REGISTRATION_ENABLED !== 'false' && process.env.NODE_ENV !== 'production');
    if (input.role === Role.STUDENT && !studentRegistrationEnabled) {
      throw new ForbiddenException('Student self-registration is disabled');
    }
    if (input.role === Role.TEACHER && process.env.TEACHER_SELF_REGISTRATION_ENABLED !== 'true') {
      throw new ForbiddenException('Teacher self-registration is disabled by university policy configuration');
    }
    if (input.password.length < 14 || input.password.length > 128) throw new BadRequestException('Password must be 14 to 128 characters');
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (name.length < 2 || name.length > 160) throw new BadRequestException('Name must be 2 to 160 characters');
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      const user = await this.prisma.user.create({
        data: { email, name, role: input.role, passwordHash },
        select: { id: true, email: true, name: true, role: true, status: true },
      });
      return this.issue(user.id, user.email, user.role);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw error;
    }
  }
  private async issue(userId: string, email: string, role: Role) {
    const access = await this.jwt.signAsync({ sub: userId, email, role }, { secret: process.env.JWT_ACCESS_SECRET!, expiresIn: (process.env.JWT_ACCESS_TTL ?? '10m') as `${number}${'s'|'m'|'h'|'d'}` });
    const refresh = randomBytes(48).toString('base64url');
    const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 14);
    await this.prisma.authSession.create({ data: { userId, refreshTokenHash: digest(refresh), expiresAt: new Date(Date.now() + days * 86400000) } });
    return { access, refresh, user: { id: userId, email, role } };
  }
  async refresh(raw: string) {
    const old = await this.prisma.authSession.findUnique({ where: { refreshTokenHash: digest(raw) }, include: { user: true } });
    if (!old || old.revokedAt || old.expiresAt <= new Date() || old.user.status !== 'ACTIVE') throw new UnauthorizedException('Refresh session expired');
    const replacement = randomBytes(48).toString('base64url');
    const days = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 14);
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authSession.updateMany({ where: { id: old.id, revokedAt: null, expiresAt: { gt: new Date() } }, data: { revokedAt: new Date() } });
      if (consumed.count !== 1) throw new UnauthorizedException('Refresh session was already used');
      await tx.authSession.create({ data: { userId: old.userId, refreshTokenHash: digest(replacement), expiresAt: new Date(Date.now() + days * 86400000) } });
    }, { isolationLevel: 'Serializable' });
    const access = await this.jwt.signAsync({ sub: old.userId, email: old.user.email, role: old.user.role }, { secret: process.env.JWT_ACCESS_SECRET!, expiresIn: (process.env.JWT_ACCESS_TTL ?? '10m') as `${number}${'s'|'m'|'h'|'d'}` });
    return { access, refresh: replacement, user: { id: old.userId, email: old.user.email, role: old.user.role } };
  }
  async logout(raw?: string) { if (raw) await this.prisma.authSession.updateMany({ where: { refreshTokenHash: digest(raw), revokedAt: null }, data: { revokedAt: new Date() } }); }
  async me(id: string) { const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, email: true, name: true, role: true, status: true } }); if (!user) throw new UnauthorizedException(); return user; }
  async bootstrapAdmin(email: string, password: string, name: string) {
    if (!email || password.length < 14 || !name) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL, a password of at least 14 characters, and BOOTSTRAP_ADMIN_NAME');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    return this.prisma.$transaction(async tx => {
      if (await tx.user.count({ where: { role: 'ADMIN' } })) throw new ConflictException('An administrator already exists');
      return tx.user.create({ data: { email: email.toLowerCase(), name, role: 'ADMIN', passwordHash }, select: { id: true, email: true, name: true, role: true } });
    }, { isolationLevel: 'Serializable' });
  }
}
