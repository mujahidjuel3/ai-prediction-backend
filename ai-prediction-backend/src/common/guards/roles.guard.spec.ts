import { ForbiddenException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  it('allows a listed role', () => {
    const reflector = { getAllAndOverride: () => [Role.ADMIN] } as never;
    const guard = new RolesGuard(reflector as never);
    const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => ({ user: { role: Role.ADMIN } }) }) } as never;
    expect(guard.canActivate(context)).toBe(true);
  });
  it('denies an unlisted role', () => {
    const reflector = { getAllAndOverride: () => [Role.ADMIN] } as never;
    const guard = new RolesGuard(reflector as never);
    const context = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => ({ user: { role: Role.STUDENT } }) }) } as never;
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
