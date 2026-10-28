import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
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
