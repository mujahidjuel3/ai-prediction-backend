/**
 * National University of Bangladesh grading (B.Sc. honours scale).
 * Attendance is not an input. There is no unweighted-average fallback.
 *
 * Repeated course attempts are not collapsed unless the caller passes an
 * explicit retake policy. The deployment default is unset.
 */

/** Institution retake rule. Leave unset until the university confirms which attempt counts. */
export type RetakePolicy = 'LATEST_ATTEMPT' | 'HIGHEST_GRADE_POINT';

export const CONFIGURED_RETAKE_POLICY: RetakePolicy | null = null;

export const GPA_CALCULATION_VERSION = 'NU-GPA-v1';

export const RETAKE_POLICY_UNCONFIGURED = 'RETAKE_POLICY_UNCONFIGURED';

const GRADE_BANDS: ReadonlyArray<{ min: number; letter: string; gradePoint: number }> = [
  { min: 80, letter: 'A+', gradePoint: 4 },
  { min: 75, letter: 'A', gradePoint: 3.75 },
  { min: 70, letter: 'A-', gradePoint: 3.5 },
  { min: 65, letter: 'B+', gradePoint: 3.25 },
  { min: 60, letter: 'B', gradePoint: 3 },
  { min: 55, letter: 'B-', gradePoint: 2.75 },
  { min: 50, letter: 'C+', gradePoint: 2.5 },
  { min: 45, letter: 'C', gradePoint: 2.25 },
  { min: 40, letter: 'D', gradePoint: 2 },
  { min: 0, letter: 'F', gradePoint: 0 },
];

export type AssessmentMark = {
  score: number | null;
  maxScore: number;
  weight: number | null;
};

export type PercentageResult =
  | { ok: true; percentage: number }
  | { ok: false; code: 'INVALID_WEIGHTS' | 'MISSING_SCORE' | 'INVALID_SCORE' };

export type GradeResult =
  | { ok: true; letter: string; gradePoint: number }
  | { ok: false; code: 'PERCENTAGE_OUT_OF_RANGE' };

export type GradedCourse = {
  status: 'CALCULATED' | 'INCOMPLETE';
  gradePoint: number | null;
  credits: number;
};

export type GpaResult =
  | { ok: true; gpa: number; credits: number; courseCount: number }
  | { ok: false; code: 'INCOMPLETE_COURSES' | 'NO_COURSES' | 'INVALID_CREDITS' };

export type CompletedAttempt = {
  courseId: string;
  termStartsAt: string;
  termId: string;
  gradePoint: number | null;
  credits: number;
  status: 'CALCULATED' | 'INCOMPLETE';
};

export type CgpaResult =
  | { ok: true; cgpa: number; credits: number; courseCount: number }
  | { ok: false; code: 'INCOMPLETE_RESULTS' | 'NO_COURSES' | 'INVALID_CREDITS' | typeof RETAKE_POLICY_UNCONFIGURED; repeatedCourseIds?: string[] };

export function roundHalfUp(value: number, places: number): number {
  const factor = 10 ** places;
  const shifted = value * factor;
  const rounded = Math.sign(shifted) * Math.floor(Math.abs(shifted) + 0.5 + 1e-8);
  return rounded / factor;
}

export type CourseGradeResult =
  | { ok: true; percentage: number; letter: string; gradePoint: number }
  | { ok: false; code: 'INVALID_WEIGHTS' | 'MISSING_SCORE' | 'INVALID_SCORE' | 'PERCENTAGE_OUT_OF_RANGE' };

/** Weighted percentage, then the NU letter grade of that rounded percentage. */
export function courseGrade(marks: AssessmentMark[]): CourseGradeResult {
  const percentage = weightedCoursePercentage(marks);
  if (!percentage.ok) return percentage;
  const grade = gradeFromPercentage(percentage.percentage);
  if (!grade.ok) return grade;
  return { ok: true, percentage: percentage.percentage, letter: grade.letter, gradePoint: grade.gradePoint };
}

export function gradeFromPercentage(percentage: number): GradeResult {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return { ok: false, code: 'PERCENTAGE_OUT_OF_RANGE' };
  }
  const band = GRADE_BANDS.find((item) => percentage >= item.min);
  if (!band) return { ok: false, code: 'PERCENTAGE_OUT_OF_RANGE' };
  return { ok: true, letter: band.letter, gradePoint: band.gradePoint };
}

/**
 * Final percentage = Σ (score / maxScore) × weight, with weights expressed as percent.
 * Every assessment needs a numeric weight and a numeric score, and the weights must sum to 100.000.
 */
export function weightedCoursePercentage(marks: AssessmentMark[]): PercentageResult {
  const thousandths: number[] = [];
  for (const mark of marks) {
    if (mark.weight == null || !Number.isFinite(mark.weight) || mark.weight < 0) {
      return { ok: false, code: 'INVALID_WEIGHTS' };
    }
    const scaled = mark.weight * 1000;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) return { ok: false, code: 'INVALID_WEIGHTS' };
    thousandths.push(rounded);
  }
  if (thousandths.reduce((sum, value) => sum + value, 0) !== 100_000) {
    return { ok: false, code: 'INVALID_WEIGHTS' };
  }
  if (marks.some((mark) => mark.score == null)) return { ok: false, code: 'MISSING_SCORE' };
  for (const mark of marks) {
    const score = mark.score as number;
    if (!Number.isFinite(score) || !Number.isFinite(mark.maxScore) || mark.maxScore <= 0 || score < 0 || score > mark.maxScore) {
      return { ok: false, code: 'INVALID_SCORE' };
    }
  }
  const raw = marks.reduce((sum, mark) => sum + ((mark.score as number) / mark.maxScore) * (mark.weight as number), 0);
  return { ok: true, percentage: roundHalfUp(raw, 2) };
}

export function semesterGpa(courses: GradedCourse[]): GpaResult {
  if (courses.length === 0) return { ok: false, code: 'NO_COURSES' };
  if (courses.some((course) => course.status !== 'CALCULATED' || course.gradePoint == null)) {
    return { ok: false, code: 'INCOMPLETE_COURSES' };
  }
  return weightedPoints(courses.map((course) => ({ gradePoint: course.gradePoint as number, credits: course.credits })));
}

/**
 * Credit-weighted CGPA over completed attempts.
 * A repeated courseId is not averaged, summed, or silently replaced.
 * Without an explicit policy the result is withheld and the repeated course ids are returned.
 */
export function cumulativeCgpa(attempts: CompletedAttempt[], policy: RetakePolicy | null = CONFIGURED_RETAKE_POLICY): CgpaResult {
  if (attempts.length === 0) return { ok: false, code: 'NO_COURSES' };
  if (attempts.some((attempt) => attempt.status !== 'CALCULATED' || attempt.gradePoint == null)) {
    return { ok: false, code: 'INCOMPLETE_RESULTS' };
  }
  const calculated = attempts as Array<CompletedAttempt & { gradePoint: number }>;
  const repeatedCourseIds = repeatedIds(calculated);
  if (repeatedCourseIds.length > 0 && policy == null) {
    return { ok: false, code: RETAKE_POLICY_UNCONFIGURED, repeatedCourseIds };
  }
  const selected = policy == null ? calculated : selectAttempts(calculated, policy);
  const points = weightedPoints(selected.map((attempt) => ({ gradePoint: attempt.gradePoint, credits: attempt.credits })));
  if (!points.ok) return { ok: false, code: 'INVALID_CREDITS' };
  return { ok: true, cgpa: points.gpa, credits: points.credits, courseCount: points.courseCount };
}

function weightedPoints(courses: Array<{ gradePoint: number; credits: number }>): GpaResult {
  let quality = 0;
  let credits = 0;
  for (const course of courses) {
    if (!Number.isFinite(course.credits) || course.credits <= 0 || !Number.isFinite(course.gradePoint)) {
      return { ok: false, code: 'INVALID_CREDITS' };
    }
    quality += course.gradePoint * course.credits;
    credits += course.credits;
  }
  return {
    ok: true,
    gpa: roundHalfUp(quality / credits, 2),
    credits: roundHalfUp(credits, 2),
    courseCount: courses.length,
  };
}

function repeatedIds(attempts: Array<{ courseId: string }>): string[] {
  const counts = new Map<string, number>();
  for (const attempt of attempts) counts.set(attempt.courseId, (counts.get(attempt.courseId) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([courseId]) => courseId).sort();
}

function selectAttempts<T extends CompletedAttempt & { gradePoint: number }>(attempts: T[], policy: RetakePolicy): T[] {
  const groups = new Map<string, T[]>();
  for (const attempt of attempts) {
    const list = groups.get(attempt.courseId) ?? [];
    list.push(attempt);
    groups.set(attempt.courseId, list);
  }
  const selected: T[] = [];
  for (const list of groups.values()) {
    const ordered = [...list].sort(compareAttempt);
    if (policy === 'LATEST_ATTEMPT') {
      selected.push(ordered[ordered.length - 1]!);
      continue;
    }
    const best = [...ordered].sort((left, right) => left.gradePoint - right.gradePoint || compareAttempt(left, right));
    selected.push(best[best.length - 1]!);
  }
  return selected;
}

function compareAttempt(left: CompletedAttempt, right: CompletedAttempt): number {
  const byDate = left.termStartsAt.localeCompare(right.termStartsAt);
  if (byDate !== 0) return byDate;
  return left.termId.localeCompare(right.termId);
}
