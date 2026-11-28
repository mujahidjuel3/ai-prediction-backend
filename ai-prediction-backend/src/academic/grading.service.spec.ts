import { NotFoundException } from '@nestjs/common';
import { EnrollmentStatus } from '@prisma/client';
import { GradingService } from './grading.service';

describe('GradingService', () => {
  function harness() {
    const tx = {
      courseResult: {
        upsert: jest.fn(async (args: { where: { enrollmentId: string }; create: unknown; update: Record<string, unknown> }) => args.create),
      },
      academicSummary: {
        upsert: jest.fn(async (args: {
          where: { studentId_termId_calculationVersion: { termId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => args.create),
      },
    };
    const prisma = {
      student: { findUnique: jest.fn().mockResolvedValue({ id: 'student-1' }) },
      academicTerm: { findUnique: jest.fn().mockResolvedValue({ id: 'term-1' }) },
      enrollment: { findMany: jest.fn() },
      $transaction: jest.fn(async (run: (client: typeof tx) => Promise<void>) => run(tx)),
    };
    return { prisma, tx, service: new GradingService(prisma as never) };
  }

  function enrollment(input: {
    id: string;
    status: EnrollmentStatus;
    courseId: string;
    termId: string;
    startsAt: string;
    credits: number;
    marks: Array<{ weight: number | null; score: number | null }>;
    studentId?: string;
  }) {
    return {
      id: input.id,
      studentId: input.studentId ?? 'student-1',
      offeringId: `offering-${input.id}`,
      status: input.status,
      offering: {
        course: { id: input.courseId, credits: input.credits },
        term: { id: input.termId, startsAt: new Date(`${input.startsAt}T00:00:00.000Z`) },
        assessments: input.marks.map((mark) => ({
          maxScore: 100,
          weight: mark.weight,
          scores: mark.score === null ? [] : [{ score: mark.score }],
        })),
      },
    };
  }

  it('stores the weighted letter grade and leaves attendance untouched', async () => {
    const { prisma, tx, service } = harness();
    prisma.enrollment.findMany.mockResolvedValue([
      enrollment({
        id: 'enr-1',
        status: EnrollmentStatus.COMPLETED,
        courseId: 'course-1',
        termId: 'term-1',
        startsAt: '2026-07-01',
        credits: 3,
        marks: [{ weight: 40, score: 80 }, { weight: 60, score: 90 }],
      }),
    ]);

    const report = await service.recalculateStudent('student-1');

    expect(report.courseResults).toEqual([
      expect.objectContaining({ letterGrade: 'A+', gradePoint: 4, percentage: 86, status: 'CALCULATED' }),
    ]);
    expect(report.terms).toEqual([{ termId: 'term-1', gpa: 4, cgpa: 4, cgpaBlockReason: null }]);
    expect(report.cgpa).toEqual({ ok: true, cgpa: 4, credits: 3, courseCount: 1 });
    const summary = tx.academicSummary.upsert.mock.calls[0][0];
    expect(summary.create).not.toHaveProperty('attendancePercent');
    expect(summary.update).not.toHaveProperty('attendancePercent');
    expect(summary.create).not.toHaveProperty('assessmentAverage');
  });

  it('does not let an in-progress course block the GPA of completed courses', async () => {
    const { prisma, service } = harness();
    prisma.enrollment.findMany.mockResolvedValue([
      enrollment({
        id: 'enr-done',
        status: EnrollmentStatus.COMPLETED,
        courseId: 'course-1',
        termId: 'term-1',
        startsAt: '2026-07-01',
        credits: 3,
        marks: [{ weight: 100, score: 80 }],
      }),
      enrollment({
        id: 'enr-open',
        status: EnrollmentStatus.ENROLLED,
        courseId: 'course-2',
        termId: 'term-1',
        startsAt: '2026-07-01',
        credits: 3,
        marks: [{ weight: 100, score: null }],
      }),
    ]);

    const report = await service.recalculateStudent('student-1');

    expect(report.courseResults.map((result) => result.status)).toEqual(['CALCULATED', 'INCOMPLETE']);
    expect(report.terms[0]).toEqual({ termId: 'term-1', gpa: 4, cgpa: 4, cgpaBlockReason: null });
  });

  it('withholds CGPA instead of choosing a repeated attempt', async () => {
    const { prisma, tx, service } = harness();
    prisma.enrollment.findMany.mockResolvedValue([
      enrollment({
        id: 'enr-1',
        status: EnrollmentStatus.COMPLETED,
        courseId: 'course-1',
        termId: 'term-1',
        startsAt: '2025-07-01',
        credits: 3,
        marks: [{ weight: 100, score: 50 }],
      }),
      enrollment({
        id: 'enr-2',
        status: EnrollmentStatus.COMPLETED,
        courseId: 'course-1',
        termId: 'term-2',
        startsAt: '2026-07-01',
        credits: 3,
        marks: [{ weight: 100, score: 85 }],
      }),
    ]);

    const report = await service.recalculateStudent('student-1');

    expect(report.cgpa).toEqual({
      ok: false,
      code: 'RETAKE_POLICY_UNCONFIGURED',
      repeatedCourseIds: ['course-1'],
    });
    const later = tx.academicSummary.upsert.mock.calls.map((call) => call[0].create).find((row) => row.termId === 'term-2');
    expect(later).toMatchObject({ gpa: 4, cgpa: null, cgpaBlockReason: 'RETAKE_POLICY_UNCONFIGURED' });
  });

  it('rejects an unknown student before writing', async () => {
    const { prisma, service } = harness();
    prisma.student.findUnique.mockResolvedValue(null);
    await expect(service.recalculateStudent('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.enrollment.findMany).not.toHaveBeenCalled();
  });

  it('recalculates one student in a term and repeats the same enrollment upsert', async () => {
    const { prisma, tx, service } = harness();
    prisma.academicTerm.findUnique.mockResolvedValue({ id: 'term-2' });
    prisma.enrollment.findMany.mockImplementation(async (args: { distinct?: string[] }) => {
      if (args.distinct) return [{ studentId: 'student-1' }];
      return [
        enrollment({
          id: 'enr-prior',
          status: EnrollmentStatus.COMPLETED,
          courseId: 'course-prior',
          termId: 'term-1',
          startsAt: '2025-07-01',
          credits: 3,
          marks: [{ weight: 100, score: 80 }],
        }),
        enrollment({
          id: 'enr-current',
          status: EnrollmentStatus.COMPLETED,
          courseId: 'course-current',
          termId: 'term-2',
          startsAt: '2026-07-01',
          credits: 3,
          marks: [{ weight: 100, score: 60 }],
        }),
      ];
    });

    const first = await service.recalculateForTerm('term-2', 'student-1');
    const second = await service.recalculateForTerm('term-2', 'student-1');

    expect(first).toMatchObject({
      termId: 'term-2',
      studentId: 'student-1',
      processed: 1,
      completed: 1,
      incomplete: 0,
      blocked: 0,
      students: [{ studentId: 'student-1', gpa: 3, cgpa: 3.5, blocked: false, blockReason: null }],
    });
    expect(second.processed).toBe(1);
    expect(tx.courseResult.upsert.mock.calls.map((call) => call[0].where)).toEqual([
      { enrollmentId: 'enr-current' },
      { enrollmentId: 'enr-current' },
    ]);
    expect(tx.academicSummary.upsert.mock.calls.map((call) => call[0].where.studentId_termId_calculationVersion.termId)).toEqual(['term-2', 'term-2']);
    expect(tx.academicSummary.upsert.mock.calls[0][0].update).not.toHaveProperty('attendancePercent');
    expect(tx.courseResult).not.toHaveProperty('create');
  });

  it('recalculates every eligible student in a term and counts incomplete and blocked results', async () => {
    const { prisma, service } = harness();
    prisma.academicTerm.findUnique.mockResolvedValue({ id: 'term-2' });
    prisma.enrollment.findMany.mockImplementation(async (args: { distinct?: string[]; where?: { studentId?: string } }) => {
      if (args.distinct) return [{ studentId: 'student-a' }, { studentId: 'student-b' }];
      if (args.where?.studentId === 'student-a') {
        return [enrollment({
          id: 'enr-a',
          studentId: 'student-a',
          status: EnrollmentStatus.COMPLETED,
          courseId: 'course-a',
          termId: 'term-2',
          startsAt: '2026-07-01',
          credits: 3,
          marks: [{ weight: 100, score: 80 }],
        })];
      }
      return [
        enrollment({
          id: 'enr-b-old',
          studentId: 'student-b',
          status: EnrollmentStatus.COMPLETED,
          courseId: 'course-b',
          termId: 'term-1',
          startsAt: '2025-07-01',
          credits: 3,
          marks: [{ weight: 100, score: 50 }],
        }),
        enrollment({
          id: 'enr-b',
          studentId: 'student-b',
          status: EnrollmentStatus.COMPLETED,
          courseId: 'course-b',
          termId: 'term-2',
          startsAt: '2026-07-01',
          credits: 3,
          marks: [{ weight: 40, score: null }, { weight: 60, score: 90 }],
        }),
      ];
    });

    const report = await service.recalculateForTerm('term-2');

    expect(report).toMatchObject({
      termId: 'term-2',
      studentId: null,
      processed: 2,
      completed: 1,
      incomplete: 1,
      blocked: 1,
    });
    expect(report.students).toEqual([
      expect.objectContaining({ studentId: 'student-a', completed: 1, incomplete: 0, blocked: false, gpa: 4, cgpa: 4 }),
      expect.objectContaining({ studentId: 'student-b', completed: 0, incomplete: 1, blocked: true, blockReason: 'INCOMPLETE_RESULTS', gpa: null, cgpa: null }),
    ]);
  });

  it('rejects an unknown term, an unknown student, and a student with no enrollment in the term', async () => {
    const { prisma, tx, service } = harness();
    prisma.academicTerm.findUnique.mockResolvedValueOnce(null);
    await expect(service.recalculateForTerm('missing-term')).rejects.toBeInstanceOf(NotFoundException);

    prisma.academicTerm.findUnique.mockResolvedValue({ id: 'term-1' });
    prisma.student.findUnique.mockResolvedValueOnce(null);
    await expect(service.recalculateForTerm('term-1', 'missing-student')).rejects.toBeInstanceOf(NotFoundException);

    prisma.student.findUnique.mockResolvedValue({ id: 'student-1' });
    prisma.enrollment.findMany.mockResolvedValue([]);
    await expect(service.recalculateForTerm('term-1', 'student-1')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.courseResult.upsert).not.toHaveBeenCalled();
  });
});
