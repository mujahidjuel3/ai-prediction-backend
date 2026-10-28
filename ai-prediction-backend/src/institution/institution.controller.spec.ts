import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { InstitutionController } from './institution.controller';

describe('InstitutionController assessment score authorization', () => {
  it('rejects a teacher who is not assigned to the offering', async () => {
    const prisma = {
      assessment: { findUnique: jest.fn().mockResolvedValue({ id: 'assessment-uuid', offeringId: 'offering-uuid', offering: {} }) },
      courseOffering: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const controller = new InstitutionController(prisma as never);

    await expect(controller.assessmentScores('assessment-uuid', { id: 'teacher-user', role: 'TEACHER' } as never))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('InstitutionController Student/Teacher account linking', () => {
  const studentDto = { accountMode: 'CREATE' as const, email: 'new.student@example.test', initialPassword: 'local-temporary-passphrase', studentNumber: 'S-1001', name: 'Test Student', departmentId: 'department-1', enrollmentYear: 2026 };
  const account = { id: 'user-1', email: 'new.student@example.test', name: 'Test Student', role: 'STUDENT', status: 'ACTIVE' };

  function setup(overrides: Record<string, unknown> = {}) {
    const tx = {
      user: { create: jest.fn().mockResolvedValue(account), findUnique: jest.fn() },
      student: { create: jest.fn().mockResolvedValue({ id: 'student-1', userId: account.id, email: account.email }), findUnique: jest.fn(), update: jest.fn() },
      teacher: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
      ...overrides,
    };
    const prisma = { $transaction: jest.fn(async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => work(tx as never)), ...overrides };
    return { controller: new InstitutionController(prisma as never), prisma, tx };
  }

  it('creates a Student account and profile inside one transaction without returning the password hash', async () => {
    const { controller, prisma, tx } = setup();
    const result = await controller.createStudent(studentDto);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.user.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ role: 'STUDENT', email: studentDto.email }) }));
    expect(tx.student.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: account.id, email: account.email }) }));
    expect(JSON.stringify(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain(studentDto.initialPassword);
  });

  it('returns a conflict for duplicate email or institutional identifier and does not create the profile', async () => {
    const tx = { user: { create: jest.fn().mockRejectedValue({ code: 'P2002' }) }, student: { create: jest.fn() } };
    const { controller } = setup(tx);

    await expect(controller.createStudent(studentDto)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.student.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate institutional identifier conflict and lets the surrounding transaction roll back the account', async () => {
    const tx = { user: { create: jest.fn().mockResolvedValue(account) }, student: { create: jest.fn().mockRejectedValue({ code: 'P2002' }) } };
    const { controller, prisma } = setup(tx);

    await expect(controller.createStudent(studentDto)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a linked account with the wrong role', async () => {
    const tx = { user: { findUnique: jest.fn().mockResolvedValue({ ...account, role: 'TEACHER', student: null, teacher: null }) }, student: { create: jest.fn() } };
    const { controller } = setup(tx);

    await expect(controller.createStudent({ accountMode: 'LINK', userId: 'user-2', studentNumber: 'S-1002', name: 'Test Student', departmentId: 'department-1', enrollmentYear: 2026 })).rejects.toBeInstanceOf(ConflictException);
    expect(tx.student.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate profile link and rejects an inactive account', async () => {
    const linked = setup({ user: { findUnique: jest.fn().mockResolvedValue({ ...account, student: { id: 'existing-student' }, teacher: null }) } });
    await expect(linked.controller.createStudent({ accountMode: 'LINK', userId: 'user-1', studentNumber: 'S-1003', name: 'Test Student', departmentId: 'department-1', enrollmentYear: 2026 })).rejects.toBeInstanceOf(ConflictException);
    expect(linked.tx.student.create).not.toHaveBeenCalled();

    const inactive = setup({ user: { findUnique: jest.fn().mockResolvedValue({ ...account, status: 'INACTIVE', student: null, teacher: null }) } });
    await expect(inactive.controller.createStudent({ accountMode: 'LINK', userId: 'user-1', studentNumber: 'S-1004', name: 'Test Student', departmentId: 'department-1', enrollmentYear: 2026 })).rejects.toBeInstanceOf(ConflictException);
    expect(inactive.tx.student.create).not.toHaveBeenCalled();
  });

  it('uses one transaction so a profile failure rejects the paired account operation', async () => {
    const accounts: { id: string }[] = [];
    const profiles: { id: string }[] = [];
    const tx = {
      user: { create: jest.fn(async () => { accounts.push({ id: account.id }); return account; }) },
      student: { create: jest.fn(async () => { throw { code: 'P2002' }; }) },
    };
    const prisma = { $transaction: jest.fn(async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => {
      const accountSnapshot = [...accounts]; const profileSnapshot = [...profiles];
      try { const result = await work(tx as never); profiles.push({ id: 'student-1' }); return result; }
      catch (error) { accounts.splice(0, accounts.length, ...accountSnapshot); profiles.splice(0, profiles.length, ...profileSnapshot); throw error; }
    }) };
    const controller = new InstitutionController(prisma as never);

    await expect(controller.createStudent(studentDto)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(accounts).toEqual([]);
    expect(profiles).toEqual([]);
  });

  it('links an existing active Teacher account to an existing unlinked profile transactionally', async () => {
    const teacherAccount = { id: 'teacher-user', email: 'teacher@example.test', name: 'Test Teacher', role: 'TEACHER', status: 'ACTIVE', student: null, teacher: null };
    const tx = {
      user: { findUnique: jest.fn().mockResolvedValue(teacherAccount) },
      teacher: { findUnique: jest.fn().mockResolvedValue({ id: 'teacher-profile', userId: null, name: 'Test Teacher', status: 'ACTIVE' }), update: jest.fn().mockResolvedValue({ id: 'teacher-profile', userId: 'teacher-user' }) },
    };
    const { controller, prisma } = setup(tx);

    await controller.linkTeacherAccount('teacher-profile', { accountMode: 'LINK', userId: 'teacher-user' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.teacher.update).toHaveBeenCalledWith(expect.objectContaining({ data: { userId: 'teacher-user', email: 'teacher@example.test' } }));
  });

  it('does not allow a linked Student account to be reassigned to the Teacher role', async () => {
    const tx = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-1', role: 'STUDENT', student: { id: 'student-1' }, teacher: null }), update: jest.fn() },
      student: { update: jest.fn() },
    };
    const { controller } = setup(tx);

    await expect(controller.updateUser('user-1', { role: 'TEACHER' as never }, { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('preserves the existing self-demotion guard', async () => {
    const { controller, prisma } = setup();

    await expect(controller.updateUser('admin-1', { role: 'STUDENT' as never }, { id: 'admin-1', email: 'admin@example.test', role: 'ADMIN' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
