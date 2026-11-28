import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AcademicController, RecalculateGradesDto } from './academic.controller';

const TERM_ID = '11111111-1111-4111-8111-111111111111';
const STUDENT_ID = '22222222-2222-4222-8222-222222222222';

describe('AcademicController course catalog', () => {
  it('returns database rows with the standard paginated envelope', async () => {
    const course = { id: 'course-uuid', code: 'BIO101' };
    const prisma = {
      $transaction: jest.fn(async ([rows, count]: [Promise<unknown>, Promise<number>]) => Promise.all([rows, count])),
      course: {
        findMany: jest.fn().mockResolvedValue([course]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const controller = new AcademicController(prisma as never, { recalculateForTerm: jest.fn() } as never);

    await expect(controller.courseCatalog({ id: 'admin-user', role: 'ADMIN' } as never, '1', '20')).resolves.toEqual({
      data: [course],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });
    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });

  it('scopes a teacher catalog to courses in assigned offerings', async () => {
    const prisma = {
      $transaction: jest.fn(async ([rows]: [Promise<unknown>, Promise<number>]) => Promise.all([rows, Promise.resolve(0)])),
      course: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    };
    const controller = new AcademicController(prisma as never, { recalculateForTerm: jest.fn() } as never);

    await controller.courseCatalog({ id: 'teacher-user', role: 'TEACHER' } as never, undefined, undefined, 'department-uuid');

    expect(prisma.course.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { departmentId: 'department-uuid', offerings: { some: { teacher: { userId: 'teacher-user' } } } },
    }));
  });

  it('updates an academic term while validating the date range', async () => {
    const current = {
      id: 'term-1',
      code: '2026S1',
      label: 'Spring 2026',
      academicYear: '2025-2026',
      startsAt: new Date('2026-01-01'),
      endsAt: new Date('2026-05-01'),
      active: false,
    };
    const prisma = {
      academicTerm: {
        findUnique: jest.fn().mockResolvedValue(current),
        update: jest.fn().mockResolvedValue({ ...current, label: 'Spring Term 2026', active: true }),
      },
    };
    const controller = new AcademicController(prisma as never, { recalculateForTerm: jest.fn() } as never);
    await expect(controller.updateTerm('term-1', { label: 'Spring Term 2026', active: true })).resolves.toEqual({
      data: { ...current, label: 'Spring Term 2026', active: true },
    });
    expect(prisma.academicTerm.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'term-1' },
      data: expect.objectContaining({ label: 'Spring Term 2026', active: true }),
    }));
  });
});

describe('AcademicController grade recalculation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const context = (role: string) => ({
    getHandler: () => AcademicController.prototype.recalculateGrades,
    getClass: () => AcademicController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  });

  it('allows only an administrator to recalculate grades', () => {
    const guard = new RolesGuard(new Reflector());
    expect(new Reflector().get(ROLES_KEY, AcademicController.prototype.recalculateGrades)).toEqual([Role.ADMIN]);
    expect(guard.canActivate(context('ADMIN') as never)).toBe(true);
    expect(() => guard.canActivate(context('TEACHER') as never)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context('STUDENT') as never)).toThrow(ForbiddenException);
  });

  it('rejects a missing term, an invalid id, and an unknown field', async () => {
    await expect(pipe.transform({}, { type: 'body', metatype: RecalculateGradesDto })).rejects.toThrow();
    await expect(pipe.transform({ termId: 'not-a-uuid' }, { type: 'body', metatype: RecalculateGradesDto })).rejects.toThrow();
    await expect(pipe.transform({ termId: TERM_ID, studentId: 'student-1' }, { type: 'body', metatype: RecalculateGradesDto })).rejects.toThrow();
    await expect(pipe.transform({ termId: TERM_ID, attendancePercent: 90 }, { type: 'body', metatype: RecalculateGradesDto })).rejects.toThrow();
    await expect(pipe.transform({ termId: TERM_ID, studentId: STUDENT_ID }, { type: 'body', metatype: RecalculateGradesDto })).resolves.toEqual({
      termId: TERM_ID,
      studentId: STUDENT_ID,
    });
  });

  it('returns the recalculation summary for one student or a whole term', async () => {
    const summary = {
      termId: TERM_ID,
      studentId: STUDENT_ID,
      calculationVersion: 'NU-GPA-v1',
      processed: 1,
      completed: 4,
      incomplete: 1,
      blocked: 1,
      students: [],
    };
    const grading = { recalculateForTerm: jest.fn().mockResolvedValue(summary) };
    const controller = new AcademicController({} as never, grading as never);

    await expect(controller.recalculateGrades({ termId: TERM_ID, studentId: STUDENT_ID })).resolves.toEqual({ data: summary });
    await controller.recalculateGrades({ termId: TERM_ID });

    expect(grading.recalculateForTerm).toHaveBeenNthCalledWith(1, TERM_ID, STUDENT_ID);
    expect(grading.recalculateForTerm).toHaveBeenNthCalledWith(2, TERM_ID, undefined);
  });
});
