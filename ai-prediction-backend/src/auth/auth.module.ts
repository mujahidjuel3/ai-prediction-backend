import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
@Module({ imports: [JwtModule.registerAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ secret: config.getOrThrow<string>('JWT_ACCESS_SECRET') }) })], controllers: [AuthController], providers: [AuthService, JwtAuthGuard, RolesGuard, { provide: APP_GUARD, useExisting: JwtAuthGuard }, { provide: APP_GUARD, useExisting: RolesGuard }], exports: [JwtModule, AuthService, JwtAuthGuard, RolesGuard] })
export class AuthModule {}
