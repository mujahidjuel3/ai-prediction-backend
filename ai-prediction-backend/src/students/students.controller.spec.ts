import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { StudentsController } from './students.controller';

const studentId = 'student-1';
const teacher: AuthUser = { id: 'teacher-user-1', email: 'teacher@example.test', role: 'TEACHER' };
const admin: AuthUser = { id: 'admin-user-1', email: 'admin@example.test', role: 'ADMIN' };
const student: AuthUser = { id: 'student-user-1', email: 'student@example.test', role: 'STUDENT' };
const offeringA = 'offering-a';
const offeringB = 'offering-b';
const termA = 'term-a';

function activeEnrollments() {
  return [
    { offeringId: offeringA, offering: { termId: termA } },
    { offeringId: offeringB, offering: { termId: termA } },
  ];
}

function teacherPrisma() {
  return {
    enrollment: { findMany: jest.fn().mockResolvedValue(activeEnrollments()) },
    courseOffering: { findMany: jest.fn().mockResolvedValue([{ id: offeringA, termId: termA }]) },
    student: { findUnique: jest.fn() },
    assessmentScore: { findMany: jest.fn().mockResolvedValue([{ id: 'score-a', assessment: { offeringId: offeringA } }]) },
  };
}

describe('StudentsController teacher resource scope', () => {
  it('omits enrollments and term-wide academic details when the term also contains an unassigned offering', async () => {
    const prisma = teacherPrisma();
    const permittedEnrollment = { id: 'enrollment-a', offeringId: offeringA };
    prisma.student.findUnique.mockResolvedValue({
      id: studentId,
      enrollments: [permittedEnrollment],
      summaries: [],
      predictions: [],
      alerts: [],
    });
    const controller = new StudentsController(prisma as never);

    const result = await controller.detail(studentId, teacher);

    expect(result.data.enrollments).toEqual([permittedEnrollment]);
    expect(prisma.student.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: studentId },
      include: expect.objectContaining({
        enrollments: expect.objectContaining({ where: { offeringId: { in: [offeringA] } } }),
        summaries: expect.objectContaining({ where: { termId: { in: [] } } }),
        predictions: expect.objectContaining({ where: { termId: { in: [] } } }),
        alerts: expect.objectContaining({ where: { termId: { in: [] } } }),
      }),
    }));
    expect(prisma.courseOffering.findMany).toHaveBeenCalledWith({
      where: { teacher: { userId: teacher.id }, enrollments: { some: { studentId, status: 'ENROLLED' } } },
      select: { id: true, termId: true },
    });
  });

  it('returns scores only from the teacher assigned offering while preserving access to offering A', async () => {
    const prisma = teacherPrisma();
    const controller = new StudentsController(prisma as never);

    const result = await controller.records(studentId, teacher);

    expect(result.data).toEqual([{ id: 'score-a', assessment: { offeringId: offeringA } }]);
    expect(prisma.assessmentScore.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { studentId, assessment: { offeringId: { in: [offeringA] } } },
    }));
  });

  it('denies a teacher with no active assigned offering for the requested student', async () => {
    const prisma = teacherPrisma();
    prisma.courseOffering.findMany.mockResolvedValue([]);
    const controller = new StudentsController(prisma as never);

    await expect(controller.records(studentId, teacher)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.assessmentScore.findMany).not.toHaveBeenCalled();
  });

  it('keeps Admin detail access unrestricted by teacher offering filters', async () => {
    const prisma = teacherPrisma();
    const adminDetail = { id: studentId, enrollments: [{ offeringId: offeringA }, { offeringId: offeringB }] };
    prisma.student.findUnique.mockResolvedValue(adminDetail);
    const controller = new StudentsController(prisma as never);

    await expect(controller.detail(studentId, admin)).resolves.toEqual({ data: adminDetail });
    expect(prisma.courseOffering.findMany).not.toHaveBeenCalled();
    const query = prisma.student.findUnique.mock.calls[0][0];
    expect(query.include.enrollments).not.toHaveProperty('where');
    expect(query.include.summaries).not.toHaveProperty('where');
  });

  it('keeps Admin records access unrestricted by teacher offering filters', async () => {
    const prisma = teacherPrisma();
    const controller = new StudentsController(prisma as never);

    await controller.records(studentId, admin);

    expect(prisma.courseOffering.findMany).not.toHaveBeenCalled();
    expect(prisma.assessmentScore.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { studentId },
    }));
  });

  it('denies a Student requesting another student’s records', async () => {
    const prisma = teacherPrisma();
    prisma.student.findUnique.mockResolvedValue({ id: 'different-student' });
    const controller = new StudentsController(prisma as never);

    await expect(controller.records(studentId, student)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.assessmentScore.findMany).not.toHaveBeenCalled();
  });
});
