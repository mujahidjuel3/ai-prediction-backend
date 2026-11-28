import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

const CALCULATION_VERSION = 'DEMO-IST-CSE-v2';

@Injectable()
export class AcademicSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async recalculate(termId?: string) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        student: { studentNumber: { startsWith: 'IST-CSE-' } },
        ...(termId ? { offering: { termId } } : {}),
      },
      select: {
        studentId: true,
        offering: { select: { termId: true } },
      },
    });

    const groups = new Map<string, { studentId: string; termId: string }>();
    for (const row of enrollments) {
      const key = `${row.studentId}|${row.offering.termId}`;
      groups.set(key, { studentId: row.studentId, termId: row.offering.termId });
    }

    const studentIds = [...new Set(enrollments.map((e) => e.studentId))];
    const termIds = [...new Set(enrollments.map((e) => e.offering.termId))];

    if (!groups.size) {
      return { calculationVersion: CALCULATION_VERSION, processed: 0, message: 'No matching enrollments found.' };
    }

    const [attendance, scores] = await Promise.all([
      this.prisma.attendanceRecord.findMany({
        where: { studentId: { in: studentIds }, offering: { termId: { in: termIds } } },
        select: { studentId: true, status: true, offering: { select: { termId: true } } },
      }),
      this.prisma.assessmentScore.findMany({
        where: {
          studentId: { in: studentIds },
          score: { not: null },
          assessment: { offering: { termId: { in: termIds } } },
        },
        select: {
          studentId: true,
          score: true,
          assessment: {
            select: {
              maxScore: true,
              weight: true,
              offering: { select: { termId: true } },
            },
          },
        },
      }),
    ]);

    const attendanceByGroup = new Map<string, { attended: number; counted: number }>();
    for (const row of attendance) {
      const key = `${row.studentId}|${row.offering.termId}`;
      const value = attendanceByGroup.get(key) ?? { attended: 0, counted: 0 };
      if (row.status !== 'EXCUSED') {
        value.counted += 1;
        if (row.status === 'PRESENT' || row.status === 'LATE') value.attended += 1;
      }
      attendanceByGroup.set(key, value);
    }

    const scoresByGroup = new Map<string, Array<{ percent: number; weight: number }>>();
    for (const row of scores) {
      if (row.score === null || Number(row.assessment.maxScore) <= 0) continue;
      const key = `${row.studentId}|${row.assessment.offering.termId}`;
      const list = scoresByGroup.get(key) ?? [];
      list.push({
        percent: (Number(row.score) / Number(row.assessment.maxScore)) * 100,
        weight: row.assessment.weight === null ? 0 : Number(row.assessment.weight),
      });
      scoresByGroup.set(key, list);
    }

    let updated = 0;
    let attendanceCalculated = 0;
    let assessmentCalculated = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const [key, group] of groups) {
        const a = attendanceByGroup.get(key);
        const s = scoresByGroup.get(key) ?? [];

        const attendancePercent =
          a && a.counted > 0 ? (a.attended / a.counted) * 100 : null;

        let assessmentAverage: number | null = null;
        if (s.length) {
          const hasCompleteWeights = s.every((item) => item.weight > 0);
          const totalWeight = s.reduce((sum, item) => sum + item.weight, 0);
          assessmentAverage = hasCompleteWeights && totalWeight > 0
            ? s.reduce((sum, item) => sum + item.percent * item.weight, 0) / totalWeight
            : s.reduce((sum, item) => sum + item.percent, 0) / s.length;
        }

        if (attendancePercent !== null) attendanceCalculated += 1;
        if (assessmentAverage !== null) assessmentCalculated += 1;

        await tx.academicSummary.upsert({
          where: {
            studentId_termId_calculationVersion: {
              studentId: group.studentId,
              termId: group.termId,
              calculationVersion: CALCULATION_VERSION,
            },
          },
          create: {
            ...group,
            gpa: null,
            attendancePercent: attendancePercent === null ? null : new Prisma.Decimal(attendancePercent.toFixed(2)),
            assessmentAverage: assessmentAverage === null ? null : new Prisma.Decimal(assessmentAverage.toFixed(2)),
            calculationVersion: CALCULATION_VERSION,
          },
          update: {
            gpa: null,
            attendancePercent: attendancePercent === null ? null : new Prisma.Decimal(attendancePercent.toFixed(2)),
            assessmentAverage: assessmentAverage === null ? null : new Prisma.Decimal(assessmentAverage.toFixed(2)),
            calculatedAt: new Date(),
          },
        });
        updated += 1;
      }
    }, { maxWait: 15000, timeout: 120000 });

    return {
      calculationVersion: CALCULATION_VERSION,
      processed: updated,
      attendanceCalculated,
      assessmentCalculated,
      gpaCalculated: 0,
      gpaNote: 'GPA remains null until an institution-approved grading scale is configured.',
      attendanceRule: 'PRESENT and LATE count as attended; EXCUSED is excluded from the denominator.',
      assessmentRule: 'Weighted percentage average when weights exist; otherwise arithmetic percentage average.',
    };
  }
}
