import { Injectable, NotFoundException } from '@nestjs/common';
import { CourseResultStatus, EnrollmentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import {
  CONFIGURED_RETAKE_POLICY,
  GPA_CALCULATION_VERSION,
  type CgpaResult,
  type CompletedAttempt,
  type GradedCourse,
  courseGrade,
  cumulativeCgpa,
  semesterGpa,
} from './grading';

export type StoredCourseResult = {
  enrollmentId: string;
  courseId: string;
  termId: string;
  status: 'CALCULATED' | 'INCOMPLETE';
  percentage: number | null;
  letterGrade: string | null;
  gradePoint: number | null;
  credits: number;
  incompleteReason: string | null;
};

export type StoredTermStanding = {
  termId: string;
  gpa: number | null;
  cgpa: number | null;
  cgpaBlockReason: string | null;
};

export type StudentGradingReport = {
  studentId: string;
  calculationVersion: string;
  courseResults: StoredCourseResult[];
  terms: StoredTermStanding[];
  cgpa: CgpaResult;
};

export type TermStudentOutcome = {
  studentId: string;
  completed: number;
  incomplete: number;
  blocked: boolean;
  blockReason: string | null;
  gpa: number | null;
  cgpa: number | null;
};

export type TermGradeRecalculation = {
  termId: string;
  studentId: string | null;
  calculationVersion: string;
  processed: number;
  completed: number;
  incomplete: number;
  blocked: number;
  students: TermStudentOutcome[];
};

type Draft = StoredCourseResult & {
  offeringId: string;
  studentId: string;
  termStartsAt: string;
  enrollmentStatus: EnrollmentStatus;
};

@Injectable()
export class GradingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recalculates course results, semester GPA, and cumulative CGPA.
   * Writes CourseResult and AcademicSummary gpa/cgpa columns only.
   * Does not read or write attendance.
   */
  async recalculateStudent(studentId: string): Promise<StudentGradingReport> {
    const student = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true } });
    if (!student) throw new NotFoundException('Student not found');

    const drafts = await this.loadDrafts(studentId);
    const completed = drafts.filter((draft) => draft.enrollmentStatus === EnrollmentStatus.COMPLETED);
    const terms = termStandings(completed);
    const cgpa = cumulativeCgpa(completed.map(toAttempt), CONFIGURED_RETAKE_POLICY);
    await this.persist(studentId, drafts, terms);

    return {
      studentId,
      calculationVersion: GPA_CALCULATION_VERSION,
      courseResults: drafts.map(toStored),
      terms,
      cgpa,
    };
  }

  /**
   * Recalculates one term. Pass studentId for that student, or omit it to
   * recalculate every student with a non-withdrawn enrollment in the term.
   * Course results are upserted by enrollment. Attendance is not written.
   * CGPA for the term still includes earlier completed attempts.
   */
  async recalculateForTerm(termId: string, studentId?: string): Promise<TermGradeRecalculation> {
    const term = await this.prisma.academicTerm.findUnique({ where: { id: termId }, select: { id: true } });
    if (!term) throw new NotFoundException('Academic term not found');
    if (studentId) {
      const student = await this.prisma.student.findUnique({ where: { id: studentId }, select: { id: true } });
      if (!student) throw new NotFoundException('Student not found');
    }

    const eligible = await this.prisma.enrollment.findMany({
      where: {
        status: { not: EnrollmentStatus.WITHDRAWN },
        offering: { termId },
        ...(studentId ? { studentId } : {}),
      },
      distinct: ['studentId'],
      select: { studentId: true },
      orderBy: { studentId: 'asc' },
    });
    if (studentId && eligible.length === 0) throw new NotFoundException('Student has no enrollment in this term');

    const students: TermStudentOutcome[] = [];
    for (const row of eligible) students.push(await this.recalculateStudentForTerm(row.studentId, termId));
    return {
      termId,
      studentId: studentId ?? null,
      calculationVersion: GPA_CALCULATION_VERSION,
      processed: students.length,
      completed: students.reduce((sum, student) => sum + student.completed, 0),
      incomplete: students.reduce((sum, student) => sum + student.incomplete, 0),
      blocked: students.filter((student) => student.blocked).length,
      students,
    };
  }

  private async recalculateStudentForTerm(studentId: string, termId: string): Promise<TermStudentOutcome> {
    const drafts = await this.loadDrafts(studentId);
    const termDrafts = drafts.filter((draft) => draft.termId === termId);
    const completed = drafts.filter((draft) => draft.enrollmentStatus === EnrollmentStatus.COMPLETED);
    const standing = termStandings(completed).find((term) => term.termId === termId) ?? null;
    await this.persist(studentId, termDrafts, standing ? [standing] : []);
    return {
      studentId,
      completed: termDrafts.filter((draft) => draft.status === 'CALCULATED').length,
      incomplete: termDrafts.filter((draft) => draft.status === 'INCOMPLETE').length,
      blocked: Boolean(standing?.cgpaBlockReason),
      blockReason: standing?.cgpaBlockReason ?? null,
      gpa: standing?.gpa ?? null,
      cgpa: standing?.cgpa ?? null,
    };
  }

  private async loadDrafts(studentId: string): Promise<Draft[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId, status: { not: EnrollmentStatus.WITHDRAWN } },
      include: {
        offering: {
          include: {
            course: { select: { id: true, credits: true } },
            term: { select: { id: true, startsAt: true } },
            assessments: {
              select: {
                maxScore: true,
                weight: true,
                scores: { where: { studentId }, select: { score: true } },
              },
            },
          },
        },
      },
    });
    return enrollments.map((enrollment) => this.draftResult(studentId, enrollment));
  }

  private async persist(studentId: string, drafts: Draft[], terms: StoredTermStanding[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const draft of drafts) {
        const data = {
          courseId: draft.courseId,
          offeringId: draft.offeringId,
          termId: draft.termId,
          percentage: draft.percentage,
          letterGrade: draft.letterGrade,
          gradePoint: draft.gradePoint,
          credits: draft.credits,
          status: draft.status === 'CALCULATED' ? CourseResultStatus.CALCULATED : CourseResultStatus.INCOMPLETE,
          incompleteReason: draft.incompleteReason,
          calculationVersion: GPA_CALCULATION_VERSION,
        };
        await tx.courseResult.upsert({
          where: { enrollmentId: draft.enrollmentId },
          create: { enrollmentId: draft.enrollmentId, studentId, ...data },
          update: { ...data, calculatedAt: new Date() },
        });
      }
      for (const term of terms) {
        const standing = {
          gpa: term.gpa,
          cgpa: term.cgpa,
          cgpaBlockReason: term.cgpaBlockReason,
          calculatedAt: new Date(),
        };
        await tx.academicSummary.upsert({
          where: {
            studentId_termId_calculationVersion: {
              studentId,
              termId: term.termId,
              calculationVersion: GPA_CALCULATION_VERSION,
            },
          },
          create: {
            studentId,
            termId: term.termId,
            calculationVersion: GPA_CALCULATION_VERSION,
            ...standing,
          },
          update: standing,
        });
      }
    });
  }

  private draftResult(studentId: string, enrollment: EnrollmentForGrading): Draft {
    const grade = courseGrade(enrollment.offering.assessments.map((assessment) => ({
      score: assessment.scores[0] ? decimal(assessment.scores[0].score) : null,
      maxScore: decimal(assessment.maxScore) ?? 0,
      weight: decimal(assessment.weight),
    })));
    const credits = decimal(enrollment.offering.course.credits) ?? 0;
    return {
      enrollmentId: enrollment.id,
      studentId,
      courseId: enrollment.offering.course.id,
      offeringId: enrollment.offeringId,
      termId: enrollment.offering.term.id,
      termStartsAt: isoDate(enrollment.offering.term.startsAt),
      enrollmentStatus: enrollment.status,
      credits,
      status: grade.ok ? 'CALCULATED' : 'INCOMPLETE',
      percentage: grade.ok ? grade.percentage : null,
      letterGrade: grade.ok ? grade.letter : null,
      gradePoint: grade.ok ? grade.gradePoint : null,
      incompleteReason: grade.ok ? null : grade.code,
    };
  }
}

type EnrollmentForGrading = Prisma.EnrollmentGetPayload<{
  include: {
    offering: {
      include: {
        course: { select: { id: true; credits: true } };
        term: { select: { id: true; startsAt: true } };
        assessments: { select: { maxScore: true; weight: true; scores: { select: { score: true } } } };
      };
    };
  };
}>;

function termStandings(completed: Draft[]): StoredTermStanding[] {
  const terms = new Map<string, string>();
  for (const draft of completed) terms.set(draft.termId, draft.termStartsAt);
  return [...terms.entries()]
    .map(([termId, termStartsAt]) => ({ termId, termStartsAt }))
    .sort((left, right) => left.termStartsAt.localeCompare(right.termStartsAt) || left.termId.localeCompare(right.termId))
    .map((term) => {
      const inTerm = completed.filter((draft) => draft.termId === term.termId).map(toGraded);
      const asOf = completed.filter((draft) => draft.termStartsAt <= term.termStartsAt).map(toAttempt);
      const gpa = semesterGpa(inTerm);
      const cgpa = cumulativeCgpa(asOf, CONFIGURED_RETAKE_POLICY);
      return {
        termId: term.termId,
        gpa: gpa.ok ? gpa.gpa : null,
        cgpa: cgpa.ok ? cgpa.cgpa : null,
        cgpaBlockReason: cgpa.ok ? null : cgpa.code,
      };
    });
}

function toGraded(draft: Draft): GradedCourse {
  return { status: draft.status, gradePoint: draft.gradePoint, credits: draft.credits };
}

function toAttempt(draft: Draft): CompletedAttempt {
  return {
    courseId: draft.courseId,
    termStartsAt: draft.termStartsAt,
    termId: draft.termId,
    gradePoint: draft.gradePoint,
    credits: draft.credits,
    status: draft.status,
  };
}

function toStored(draft: Draft): StoredCourseResult {
  return {
    enrollmentId: draft.enrollmentId,
    courseId: draft.courseId,
    termId: draft.termId,
    status: draft.status,
    percentage: draft.percentage,
    letterGrade: draft.letterGrade,
    gradePoint: draft.gradePoint,
    credits: draft.credits,
    incompleteReason: draft.incompleteReason,
  };
}

function decimal(value: Prisma.Decimal | number | null | undefined): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isoDate(value: Date): string {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
