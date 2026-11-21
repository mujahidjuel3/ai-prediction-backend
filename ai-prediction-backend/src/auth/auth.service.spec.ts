import { ConflictException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService registration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  function build(prisma: Record<string, unknown>) {
    process.env.JWT_ACCESS_SECRET = 'z'.repeat(32);
    process.env.JWT_ACCESS_TTL = '10m';
    process.env.REFRESH_TOKEN_TTL_DAYS = '14';
    const jwt = { signAsync: jest.fn().mockResolvedValue('access-token') } as unknown as JwtService;
    return new AuthService(prisma as never, jwt);
  }

  it('rejects administrator self-registration', async () => {
    const service = build({ user: { create: jest.fn() }, authSession: { create: jest.fn() } });
    await expect(service.register({ email: 'admin@example.test', password: 'local-temporary-pass', name: 'Admin', role: Role.ADMIN })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects teacher self-registration when the policy flag is off', async () => {
    process.env.TEACHER_SELF_REGISTRATION_ENABLED = 'false';
    const service = build({ user: { create: jest.fn() }, authSession: { create: jest.fn() } });
    await expect(service.register({ email: 'teacher@example.test', password: 'local-temporary-pass', name: 'Teacher', role: Role.TEACHER })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates a student login account without an academic profile and issues a session', async () => {
    process.env.STUDENT_SELF_REGISTRATION_ENABLED = 'true';
    process.env.NODE_ENV = 'test';
    const create = jest.fn().mockResolvedValue({ id: 'user-1', email: 'student@example.test', name: 'Student', role: Role.STUDENT, status: 'ACTIVE' });
    const sessionCreate = jest.fn().mockResolvedValue({ id: 'session-1' });
    const service = build({ user: { create }, authSession: { create: sessionCreate } });
    const result = await service.register({ email: 'Student@Example.TEST', password: 'local-temporary-pass', name: 'Student One', role: Role.STUDENT });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: 'student@example.test', name: 'Student One', role: Role.STUDENT, passwordHash: expect.any(String) }),
    }));
    expect(create.mock.calls[0][0].data.passwordHash).not.toContain('local-temporary-pass');
    expect(sessionCreate).toHaveBeenCalled();
    expect(result.user).toEqual({ id: 'user-1', email: 'student@example.test', role: Role.STUDENT });
  });

  it('maps duplicate email registration to a conflict', async () => {
    process.env.STUDENT_SELF_REGISTRATION_ENABLED = 'true';
    const create = jest.fn().mockRejectedValue({ code: 'P2002' });
    const service = build({ user: { create }, authSession: { create: jest.fn() } });
    await expect(service.register({ email: 'dup@example.test', password: 'local-temporary-pass', name: 'Dup', role: Role.STUDENT })).rejects.toBeInstanceOf(ConflictException);
  });
});
