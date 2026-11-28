import { courseGrade, cumulativeCgpa, gradeFromPercentage, roundHalfUp, semesterGpa, weightedCoursePercentage } from './grading';

describe('National University grade boundaries', () => {
  const boundaries: Array<[number, string, number]> = [
    [100, 'A+', 4],
    [80, 'A+', 4],
    [79.99, 'A', 3.75],
    [75, 'A', 3.75],
    [74.99, 'A-', 3.5],
    [70, 'A-', 3.5],
    [69.99, 'B+', 3.25],
    [65, 'B+', 3.25],
    [64.99, 'B', 3],
    [60, 'B', 3],
    [59.99, 'B-', 2.75],
    [55, 'B-', 2.75],
    [54.99, 'C+', 2.5],
    [50, 'C+', 2.5],
    [49.99, 'C', 2.25],
    [45, 'C', 2.25],
    [44.99, 'D', 2],
    [40, 'D', 2],
    [39.99, 'F', 0],
    [0, 'F', 0],
  ];

  it.each(boundaries)('maps %s to %s (%s)', (percentage, letter, gradePoint) => {
    expect(gradeFromPercentage(percentage)).toEqual({ ok: true, letter, gradePoint });
  });

  it('rejects percentages outside 0–100', () => {
    expect(gradeFromPercentage(-0.01)).toEqual({ ok: false, code: 'PERCENTAGE_OUT_OF_RANGE' });
    expect(gradeFromPercentage(100.01)).toEqual({ ok: false, code: 'PERCENTAGE_OUT_OF_RANGE' });
    expect(gradeFromPercentage(Number.NaN)).toEqual({ ok: false, code: 'PERCENTAGE_OUT_OF_RANGE' });
  });

  it('rounds a weighted percentage onto the boundary before assigning the letter', () => {
    expect(roundHalfUp(79.995, 2)).toBe(80);
    expect(roundHalfUp(39.995, 2)).toBe(40);
    expect(courseGrade([{ score: 79.995, maxScore: 100, weight: 100 }])).toEqual({
      ok: true, percentage: 80, letter: 'A+', gradePoint: 4,
    });
    expect(courseGrade([{ score: 39.995, maxScore: 100, weight: 100 }])).toEqual({
      ok: true, percentage: 40, letter: 'D', gradePoint: 2,
    });
  });
});

describe('weighted course percentage', () => {
  it('weights every assessment and requires the weights to total 100', () => {
    expect(weightedCoursePercentage([
      { score: 80, maxScore: 100, weight: 40 },
      { score: 70, maxScore: 100, weight: 60 },
    ])).toEqual({ ok: true, percentage: 74 });
    expect(courseGrade([
      { score: 80, maxScore: 100, weight: 40 },
      { score: 70, maxScore: 100, weight: 60 },
    ])).toMatchObject({ ok: true, percentage: 74, letter: 'A-', gradePoint: 3.5 });
  });

  it('accepts weights that meet 100 only at three decimal places', () => {
    expect(weightedCoursePercentage([
      { score: 90, maxScore: 100, weight: 33.333 },
      { score: 90, maxScore: 100, weight: 33.333 },
      { score: 90, maxScore: 100, weight: 33.334 },
    ])).toEqual({ ok: true, percentage: 90 });
  });

  it('rejects weights that do not total exactly 100', () => {
    expect(weightedCoursePercentage([
      { score: 80, maxScore: 100, weight: 40 },
      { score: 90, maxScore: 100, weight: 50 },
    ])).toEqual({ ok: false, code: 'INVALID_WEIGHTS' });
  });

  it('rejects a missing weight, a negative weight, and an empty assessment list', () => {
    expect(weightedCoursePercentage([
      { score: 80, maxScore: 100, weight: null },
      { score: 90, maxScore: 100, weight: 100 },
    ])).toEqual({ ok: false, code: 'INVALID_WEIGHTS' });
    expect(weightedCoursePercentage([{ score: 80, maxScore: 100, weight: -1 }])).toEqual({ ok: false, code: 'INVALID_WEIGHTS' });
    expect(weightedCoursePercentage([])).toEqual({ ok: false, code: 'INVALID_WEIGHTS' });
  });

  it('does not fall back to an unweighted average when weights are missing', () => {
    const result = weightedCoursePercentage([
      { score: 80, maxScore: 100, weight: null },
      { score: 40, maxScore: 100, weight: null },
    ]);
    expect(result).toEqual({ ok: false, code: 'INVALID_WEIGHTS' });
    expect(result).not.toMatchObject({ percentage: 60 });
  });

  it('requires a score on every assessment', () => {
    expect(weightedCoursePercentage([
      { score: 80, maxScore: 100, weight: 40 },
      { score: null, maxScore: 100, weight: 60 },
    ])).toEqual({ ok: false, code: 'MISSING_SCORE' });
  });

  it('rejects a score above the maximum or a non-positive maximum', () => {
    expect(weightedCoursePercentage([{ score: 101, maxScore: 100, weight: 100 }])).toEqual({ ok: false, code: 'INVALID_SCORE' });
    expect(weightedCoursePercentage([{ score: 10, maxScore: 0, weight: 100 }])).toEqual({ ok: false, code: 'INVALID_SCORE' });
  });
});

describe('semester GPA', () => {
  it('is the credit-weighted mean of course grade points', () => {
    expect(semesterGpa([
      { status: 'CALCULATED', gradePoint: 4, credits: 3 },
      { status: 'CALCULATED', gradePoint: 3, credits: 1.5 },
    ])).toEqual({ ok: true, gpa: 3.67, credits: 4.5, courseCount: 2 });
  });

  it('keeps an F in the credit total', () => {
    expect(semesterGpa([
      { status: 'CALCULATED', gradePoint: 0, credits: 3 },
      { status: 'CALCULATED', gradePoint: 4, credits: 3 },
    ])).toEqual({ ok: true, gpa: 2, credits: 6, courseCount: 2 });
  });

  it('does not publish a GPA when any course result is incomplete', () => {
    expect(semesterGpa([
      { status: 'CALCULATED', gradePoint: 4, credits: 3 },
      { status: 'INCOMPLETE', gradePoint: null, credits: 3 },
    ])).toEqual({ ok: false, code: 'INCOMPLETE_COURSES' });
  });

  it('does not use attendance', () => {
    const courses = [
      { status: 'CALCULATED' as const, gradePoint: 4, credits: 3 },
      { status: 'CALCULATED' as const, gradePoint: 2, credits: 3 },
    ];
    expect(semesterGpa(courses)).toEqual({ ok: true, gpa: 3, credits: 6, courseCount: 2 });
    expect(courses.every((course) => !Object.prototype.hasOwnProperty.call(course, 'attendancePercent'))).toBe(true);
  });
});

describe('cumulative CGPA', () => {
  const passed = {
    courseId: '530201',
    termStartsAt: '2025-07-01',
    termId: 'term-5',
    gradePoint: 4,
    credits: 3,
    status: 'CALCULATED' as const,
  };
  const other = {
    courseId: '530203',
    termStartsAt: '2025-07-01',
    termId: 'term-5',
    gradePoint: 3,
    credits: 3,
    status: 'CALCULATED' as const,
  };

  it('weights completed courses across one set of attempts', () => {
    expect(cumulativeCgpa([passed, other])).toEqual({ ok: true, cgpa: 3.5, credits: 6, courseCount: 2 });
  });

  it('withholds CGPA when the same course was attempted more than once and no retake policy is configured', () => {
    const result = cumulativeCgpa([
      { ...passed, termStartsAt: '2024-07-01', termId: 'term-1', gradePoint: 2 },
      { ...passed, termStartsAt: '2025-07-01', termId: 'term-3', gradePoint: 4 },
      other,
    ]);
    expect(result).toEqual({
      ok: false,
      code: 'RETAKE_POLICY_UNCONFIGURED',
      repeatedCourseIds: ['530201'],
    });
    expect(result).not.toHaveProperty('cgpa');
  });

  it('uses one attempt when a retake policy is configured explicitly', () => {
    const attempts = [
      { ...passed, termStartsAt: '2024-07-01', termId: 'term-1', gradePoint: 4 },
      { ...passed, termStartsAt: '2025-07-01', termId: 'term-3', gradePoint: 2 },
      other,
    ];
    expect(cumulativeCgpa(attempts, 'LATEST_ATTEMPT')).toEqual({ ok: true, cgpa: 2.5, credits: 6, courseCount: 2 });
    expect(cumulativeCgpa(attempts, 'HIGHEST_GRADE_POINT')).toEqual({ ok: true, cgpa: 3.5, credits: 6, courseCount: 2 });
  });

  it('withholds CGPA when a completed attempt has no grade', () => {
    expect(cumulativeCgpa([
      passed,
      { ...other, status: 'INCOMPLETE', gradePoint: null },
    ])).toEqual({ ok: false, code: 'INCOMPLETE_RESULTS' });
  });
});
