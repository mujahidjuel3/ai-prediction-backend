/**
 * IST CSE academic DEMO dataset seeder (National University syllabus 2017–2018).
 *
 * DEFAULT MODE: dry-run (read-only). No writes.
 *
 * Write mode (future, after explicit approval) requires ALL of:
 *   --write
 *   --i-approve-production-write
 *   SEED_TARGET=production
 *   DATABASE_URL (or SEED_DATABASE_URL) pointing at Neon production
 *
 * Never creates Users, Predictions, RiskAlerts, or sends email.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';

type CatalogCourse = {
  semester: number;
  code: string;
  title: string;
  credits: number;
  track: 'core' | 'optional';
};

type TermPlan = {
  code: string;
  label: string;
  academicYear: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
};

const SECTION = 'A';
const SUMMARY_VERSION = 'DEMO-IST-CSE-v1';
const ATTENDANCE_SESSIONS = 8;
const ASSESSMENTS = [
  { name: 'DEMO Midterm', kind: 'Midterm', maxScore: 100, weight: 40 },
  { name: 'DEMO Final', kind: 'Final', maxScore: 100, weight: 60 },
] as const;

/** Final-year DEMO elective pairs (theory + matching lab). Chosen deterministically; not inventing syllabus content. */
const ELECTIVE_PAIRS: Array<{ theory: string; lab: string }> = [
  { theory: '540223', lab: '540224' },
  { theory: '540225', lab: '540226' },
  { theory: '540227', lab: '540228' },
  { theory: '540229', lab: '540230' },
  { theory: '540231', lab: '540232' },
  { theory: '540233', lab: '540234' },
  { theory: '540235', lab: '540236' },
  { theory: '540237', lab: '540238' },
  { theory: '540239', lab: '540240' },
  { theory: '540241', lab: '540242' },
  { theory: '540243', lab: '540244' },
  { theory: '540245', lab: '540246' },
  { theory: '540247', lab: '540248' },
  { theory: '540249', lab: '540250' },
];

const TERMS: TermPlan[] = [
  { code: 'DEMO-IST-2022-23-S1', label: 'DEMO · IST CSE 2022-23 Semester 1', academicYear: '2022-2023', startsAt: '2022-07-01', endsAt: '2022-12-31', active: false },
  { code: 'DEMO-IST-2022-23-S2', label: 'DEMO · IST CSE 2022-23 Semester 2', academicYear: '2022-2023', startsAt: '2023-01-01', endsAt: '2023-06-30', active: false },
  { code: 'DEMO-IST-2023-24-S1', label: 'DEMO · IST CSE 2023-24 Semester 1', academicYear: '2023-2024', startsAt: '2023-07-01', endsAt: '2023-12-31', active: false },
  { code: 'DEMO-IST-2023-24-S2', label: 'DEMO · IST CSE 2023-24 Semester 2', academicYear: '2023-2024', startsAt: '2024-01-01', endsAt: '2024-06-30', active: false },
  { code: 'DEMO-IST-2024-25-S1', label: 'DEMO · IST CSE 2024-25 Semester 1', academicYear: '2024-2025', startsAt: '2024-07-01', endsAt: '2024-12-31', active: false },
  { code: 'DEMO-IST-2024-25-S2', label: 'DEMO · IST CSE 2024-25 Semester 2', academicYear: '2024-2025', startsAt: '2025-01-01', endsAt: '2025-06-30', active: false },
  { code: 'DEMO-IST-2025-26-S1', label: 'DEMO · IST CSE 2025-26 Semester 1', academicYear: '2025-2026', startsAt: '2025-07-01', endsAt: '2025-12-31', active: false },
  { code: 'DEMO-IST-2025-26-S2', label: 'DEMO · IST CSE 2025-26 Semester 2', academicYear: '2025-2026', startsAt: '2026-01-01', endsAt: '2026-06-30', active: false },
  { code: 'DEMO-IST-2026-27-S1', label: 'DEMO · IST CSE 2026-27 Semester 1 (current)', academicYear: '2026-2027', startsAt: '2026-07-01', endsAt: '2026-12-31', active: true },
];

/**
 * Calendar term index from cohort start (Jul of enrollmentYear) + curriculum semester.
 * Sem 1 → term 0 of cohort timeline, Sem 2 → 1, …
 */
function termCodeFor(enrollmentYear: number, curriculumSemester: number): string {
  const termIndex = curriculumSemester - 1; // 0-based from cohort start
  const startYear = enrollmentYear;
  const absoluteIndex = (startYear - 2022) * 2 + termIndex;
  const map: Record<number, string> = {
    0: 'DEMO-IST-2022-23-S1',
    1: 'DEMO-IST-2022-23-S2',
    2: 'DEMO-IST-2023-24-S1',
    3: 'DEMO-IST-2023-24-S2',
    4: 'DEMO-IST-2024-25-S1',
    5: 'DEMO-IST-2024-25-S2',
    6: 'DEMO-IST-2025-26-S1',
    7: 'DEMO-IST-2025-26-S2',
    8: 'DEMO-IST-2026-27-S1',
  };
  // For 2023 cohort: Sem1 = Jul2023 = index (2023-2022)*2+0 = 2 → 2023-24-S1 ✓
  // For 2024 cohort: Sem1 = Jul2024 = index 4 → 2024-25-S1 ✓
  // For 2022 Sem8 = index 7 → 2025-26-S2 ✓ (Jan-Jun 2026)
  const key = (enrollmentYear - 2022) * 2 + (curriculumSemester - 1);
  const code = map[key];
  if (!code) throw new Error(`No term mapping for enrollmentYear=${enrollmentYear} semester=${curriculumSemester} (key=${key})`);
  void absoluteIndex;
  return code;
}

function parseArgs(argv: string[]) {
  return {
    write: argv.includes('--write'),
    approveProductionWrite: argv.includes('--i-approve-production-write'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function redactDatabaseIdentity(rawUrl: string) {
  try {
    const normalized = rawUrl.replace(/^postgresql:/i, 'http:').replace(/^postgres:/i, 'http:');
    const url = new URL(normalized);
    const host = url.hostname;
    const database = url.pathname.replace(/^\//, '').split('?')[0] || '(unknown)';
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host);
    const isNeon = /\.neon\.tech$/i.test(host);
    return {
      hostRedacted: host.includes('.') ? `***.${host.split('.').slice(-2).join('.')}` : host.replace(/./g, '*'),
      database,
      isLocal,
      isNeon,
      environmentGuess: isLocal ? 'local' : isNeon ? 'neon' : 'remote',
    };
  } catch {
    return { hostRedacted: '(unparseable)', database: '(unknown)', isLocal: false, isNeon: false, environmentGuess: 'unknown' };
  }
}

function demoScore(seed: string, max: number) {
  const digest = createHash('sha256').update(seed).digest();
  const value = 55 + (digest[0]! % 41); // 55–95
  return Math.min(max, value);
}

function loadCatalog(): CatalogCourse[] {
  const path = resolve(__dirname, '../prisma/data/ist-cse-2017-2018-catalog.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { courses: CatalogCourse[] };
  return raw.courses;
}

function electivePairForStudent(studentNumber: string) {
  const digest = createHash('sha256').update(`DEMO-ELECTIVE:${studentNumber}`).digest();
  return ELECTIVE_PAIRS[digest[0]! % ELECTIVE_PAIRS.length]!;
}

function currentCurriculumSemester(enrollmentYear: number, asOf = new Date('2026-11-28')): number {
  // Jul-start sessions: Sem N spans 6 months from cohort start.
  const start = new Date(Date.UTC(enrollmentYear, 6, 1)); // July 1
  const months = (asOf.getUTCFullYear() - start.getUTCFullYear()) * 12 + (asOf.getUTCMonth() - start.getUTCMonth());
  const sem = Math.floor(months / 6) + 1;
  return Math.min(8, Math.max(1, sem));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: npx tsx scripts/seed-ist-cse-demo.ts [--write --i-approve-production-write]
Default: dry-run (read-only).
SEED_DATABASE_URL overrides DATABASE_URL for targeting.
SEED_TARGET=production required with write flags.`);
    return;
  }

  const connectionUrl = process.env.SEED_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionUrl) throw new Error('DATABASE_URL or SEED_DATABASE_URL is required');
  const identity = redactDatabaseIdentity(connectionUrl);
  const seedTarget = (process.env.SEED_TARGET || '').toLowerCase();
  const catalog = loadCatalog();

  const writeRequested = args.write;
  if (writeRequested) {
    if (seedTarget !== 'production') {
      throw new Error('Refusing write: set SEED_TARGET=production explicitly');
    }
    if (!args.approveProductionWrite) {
      throw new Error('Refusing write: pass --i-approve-production-write after human approval');
    }
    if (identity.isLocal) {
      throw new Error('Refusing write: connection host looks local, not production Neon');
    }
    if (!identity.isNeon) {
      throw new Error('Refusing write: production write requires a Neon hostname (*.neon.tech)');
    }
    throw new Error('Write mode is implemented as a hard stop in this phase. Re-run only after a future approval updates this guard.');
  }

  const prisma = new PrismaClient({ datasources: { db: { url: connectionUrl } } });
  const warnings: string[] = [];
  const ambiguities: string[] = [
    'Sem VIII optional-lab summary OCR/print shows garbled code "245034" for Pattern Recognition Lab; detail header is 540234 — catalog uses 540234.',
    'Optional theory 540239 title uses "Forensic" while lab 540240 uses "Forensics" in the official PDF; titles kept as printed.',
    'Detail header for 540208 shows Credits : 3 while Sem VII summary table lists 1.5; catalog uses summary-table value 1.5.',
    'Teacher profiles are not created (no invented names); CourseOffering.teacherId remains null.',
    'Local DB may contain department code "9846" named "CSE" alongside code "CSE" (Computer Science and Engineering). Seed attaches courses only to department.code=CSE.',
  ];

  try {
    const [departments, students, existingCourses, existingTerms, existingOfferings, existingEnrollments, attendanceCount, assessmentCount, scoreCount, summaryCount, predictionCount, alertCount] = await Promise.all([
      prisma.department.findMany({ select: { id: true, code: true, name: true } }),
      prisma.student.findMany({
        where: { studentNumber: { startsWith: 'IST-CSE-' } },
        select: { id: true, studentNumber: true, name: true, enrollmentYear: true, departmentId: true, status: true, department: { select: { code: true } } },
        orderBy: { studentNumber: 'asc' },
      }),
      prisma.course.findMany({ where: { department: { code: 'CSE' } }, select: { id: true, code: true, name: true, credits: true } }),
      prisma.academicTerm.findMany({ select: { id: true, code: true, label: true, academicYear: true, active: true } }),
      prisma.courseOffering.findMany({
        where: { OR: [{ term: { code: { startsWith: 'DEMO-IST-' } } }, { course: { department: { code: 'CSE' } } }] },
        select: { id: true, section: true, course: { select: { code: true } }, term: { select: { code: true } } },
      }),
      prisma.enrollment.count({ where: { student: { studentNumber: { startsWith: 'IST-CSE-' } } } }),
      prisma.attendanceRecord.count({ where: { student: { studentNumber: { startsWith: 'IST-CSE-' } } } }),
      prisma.assessment.count({ where: { name: { startsWith: 'DEMO ' } } }),
      prisma.assessmentScore.count({ where: { assessment: { name: { startsWith: 'DEMO ' } } } }),
      prisma.academicSummary.count({ where: { calculationVersion: SUMMARY_VERSION } }),
      prisma.prediction.count({ where: { student: { studentNumber: { startsWith: 'IST-CSE-' } } } }),
      prisma.riskAlert.count({ where: { student: { studentNumber: { startsWith: 'IST-CSE-' } } } }),
    ]);

    const cse = departments.find((d) => d.code === 'CSE');
    if (!cse) warnings.push('Department code CSE not found — seed cannot proceed to write without it.');
    const duplicateDept = departments.filter((d) => d.name.toLowerCase().includes('computer science') || d.code === 'CSE' || d.code === '9846');
    if (duplicateDept.length > 1) {
      warnings.push(`Multiple CSE-like departments present: ${duplicateDept.map((d) => `${d.code}:${d.name}`).join('; ')}. Seed will attach courses only to code=CSE.`);
    }

    if (students.length !== 10) warnings.push(`Expected 10 IST-CSE-* students, found ${students.length}.`);
    for (const s of students) {
      if (s.department.code !== 'CSE') warnings.push(`Student ${s.studentNumber} is not in CSE department (${s.department.code}).`);
      if (![2022, 2023, 2024].includes(s.enrollmentYear)) warnings.push(`Unexpected enrollmentYear ${s.enrollmentYear} for ${s.studentNumber}.`);
    }

    const catalogBySem: Record<string, { core: number; optional: number; creditsCore: number }> = {};
    for (const course of catalog) {
      const key = `Sem ${course.semester}`;
      catalogBySem[key] ??= { core: 0, optional: 0, creditsCore: 0 };
      if (course.track === 'core') {
        catalogBySem[key].core += 1;
        catalogBySem[key].creditsCore += course.credits;
      } else catalogBySem[key].optional += 1;
    }

    const existingCourseCodes = new Set(existingCourses.map((c) => c.code));
    const coursesToCreate = catalog.filter((c) => !existingCourseCodes.has(c.code));
    const coursesReuse = catalog.filter((c) => existingCourseCodes.has(c.code));
    for (const existing of existingCourses) {
      const official = catalog.find((c) => c.code === existing.code);
      if (official && official.title !== existing.name) {
        warnings.push(`Course ${existing.code} title mismatch DB="${existing.name}" vs syllabus="${official.title}"`);
      }
    }

    const existingTermCodes = new Set(existingTerms.map((t) => t.code));
    const termsToCreate = TERMS.filter((t) => !existingTermCodes.has(t.code));
    const activeExisting = existingTerms.filter((t) => t.active);
    if (activeExisting.some((t) => t.code !== 'DEMO-IST-2026-27-S1')) {
      warnings.push(`Other active terms exist (${activeExisting.map((t) => t.code).join(', ')}); activating DEMO-IST-2026-27-S1 later would need careful coordination.`);
    }

    // Cohort progression as of 2026-11-28
    const cohortPlan = students.map((s) => {
      const currentSem = currentCurriculumSemester(s.enrollmentYear);
      const completedThrough = Math.min(8, currentSem - (currentSem === 8 && s.enrollmentYear === 2022 ? 0 : 1));
      // 2022: currentSem=8 and finished Jun 2026 → treat Sem8 as completed (no "current" active enrollment needed)
      const finishedAll = s.enrollmentYear === 2022;
      const maxCompleted = finishedAll ? 8 : currentSem - 1;
      const current = finishedAll ? null : currentSem;
      return { studentNumber: s.studentNumber, enrollmentYear: s.enrollmentYear, maxCompleted, currentSem: current };
    });

    type OfferingKey = string;
    const plannedOfferings = new Map<OfferingKey, { termCode: string; courseCode: string; curriculumSemester: number }>();
    const plannedEnrollments: Array<{ studentNumber: string; termCode: string; courseCode: string; status: 'ENROLLED' | 'COMPLETED' }> = [];

    for (const plan of cohortPlan) {
      const student = students.find((s) => s.studentNumber === plan.studentNumber)!;
      for (let sem = 1; sem <= plan.maxCompleted; sem += 1) {
        const termCode = termCodeFor(student.enrollmentYear, sem);
        const courses = catalog.filter((c) => c.semester === sem && c.track === 'core');
        for (const course of courses) {
          const key = `${termCode}|${course.code}|${SECTION}`;
          plannedOfferings.set(key, { termCode, courseCode: course.code, curriculumSemester: sem });
          plannedEnrollments.push({ studentNumber: student.studentNumber, termCode, courseCode: course.code, status: 'COMPLETED' });
        }
        if (sem === 8) {
          const pair = electivePairForStudent(student.studentNumber);
          for (const code of [pair.theory, pair.lab]) {
            const key = `${termCode}|${code}|${SECTION}`;
            plannedOfferings.set(key, { termCode, courseCode: code, curriculumSemester: 8 });
            plannedEnrollments.push({ studentNumber: student.studentNumber, termCode, courseCode: code, status: 'COMPLETED' });
          }
        }
      }
      if (plan.currentSem) {
        const sem = plan.currentSem;
        const termCode = termCodeFor(student.enrollmentYear, sem);
        const courses = catalog.filter((c) => c.semester === sem && c.track === 'core');
        for (const course of courses) {
          const key = `${termCode}|${course.code}|${SECTION}`;
          plannedOfferings.set(key, { termCode, courseCode: course.code, curriculumSemester: sem });
          plannedEnrollments.push({ studentNumber: student.studentNumber, termCode, courseCode: course.code, status: 'ENROLLED' });
        }
        if (sem === 8) {
          const pair = electivePairForStudent(student.studentNumber);
          for (const code of [pair.theory, pair.lab]) {
            const key = `${termCode}|${code}|${SECTION}`;
            plannedOfferings.set(key, { termCode, courseCode: code, curriculumSemester: 8 });
            plannedEnrollments.push({ studentNumber: student.studentNumber, termCode, courseCode: code, status: 'ENROLLED' });
          }
        }
      }
    }

    const offeringExistingKeys = new Set(existingOfferings.map((o) => `${o.term.code}|${o.course.code}|${o.section}`));
    const offeringsToCreate = [...plannedOfferings.keys()].filter((k) => !offeringExistingKeys.has(k));
    const offeringsReuse = [...plannedOfferings.keys()].filter((k) => offeringExistingKeys.has(k));

    // Current-term DEMO attendance/assessments/scores only on ENROLLED rows in active term
    const activeTerm = 'DEMO-IST-2026-27-S1';
    const currentEnrollments = plannedEnrollments.filter((e) => e.status === 'ENROLLED' && e.termCode === activeTerm);
    const currentOfferingKeys = new Set(currentEnrollments.map((e) => `${e.termCode}|${e.courseCode}|${SECTION}`));
    const plannedAttendance = currentEnrollments.length * ATTENDANCE_SESSIONS;
    const plannedAssessments = currentOfferingKeys.size * ASSESSMENTS.length;
    const plannedScores = currentEnrollments.length * ASSESSMENTS.length;
    const plannedSummaries = plannedEnrollments.filter((e) => e.status === 'COMPLETED').reduce((set, e) => {
      set.add(`${e.studentNumber}|${e.termCode}`);
      return set;
    }, new Set<string>()).size;

    const byCohort = [2022, 2023, 2024].map((year) => {
      const members = cohortPlan.filter((c) => c.enrollmentYear === year);
      const enrollments = plannedEnrollments.filter((e) => members.some((m) => m.studentNumber === e.studentNumber));
      return {
        enrollmentYear: year,
        students: members.map((m) => ({ studentNumber: m.studentNumber, maxCompleted: m.maxCompleted, currentSem: m.currentSem })),
        enrollmentRows: enrollments.length,
        enrolledNow: enrollments.filter((e) => e.status === 'ENROLLED').length,
        completed: enrollments.filter((e) => e.status === 'COMPLETED').length,
      };
    });

    const productionReachable = identity.isNeon && !identity.isLocal;
    const report = {
      mode: 'dry-run',
      writeExecuted: false,
      productionDryRunStatus: productionReachable
        ? 'CONNECTED_NEON_READ_ONLY'
        : 'BLOCKED_NO_PRODUCTION_URL',
      database: {
        ...identity,
        seedTarget: seedTarget || '(unset)',
        note: identity.isLocal
          ? 'Connected URL is local — not production Neon. Azure CLI is not logged in and no SEED_DATABASE_URL was provided. Counts below reflect the reachable database only; re-run with SEED_DATABASE_URL=…neon.tech… for a production read-only dry-run.'
          : identity.isNeon
            ? 'Neon host detected (credentials redacted). Read-only dry-run against this target.'
            : 'Remote non-Neon host detected.',
      },
      existing: {
        departments: departments.map((d) => ({ code: d.code, name: d.name })),
        cseDepartmentPresent: Boolean(cse),
        istCseStudents: students.map((s) => ({
          studentNumber: s.studentNumber,
          name: s.name,
          enrollmentYear: s.enrollmentYear,
          department: s.department.code,
          status: s.status,
        })),
        istCseStudentCount: students.length,
        cseCourseCount: existingCourses.length,
        demoTermsExisting: existingTerms.filter((t) => t.code.startsWith('DEMO-IST-')).map((t) => t.code),
        istCseEnrollmentCount: existingEnrollments,
        istCseAttendanceCount: attendanceCount,
        demoAssessmentCount: assessmentCount,
        demoScoreCount: scoreCount,
        demoSummaryCount: summaryCount,
        istCsePredictionCount: predictionCount,
        istCseAlertCount: alertCount,
      },
      officialCatalog: {
        source: 'IST/NU CSE Syllabus Effective from the Session 2017-2018',
        totalCourses: catalog.length,
        core: catalog.filter((c) => c.track === 'core').length,
        optional: catalog.filter((c) => c.track === 'optional').length,
        bySemester: catalogBySem,
        optionalPairs: ELECTIVE_PAIRS.length,
      },
      termPlan: TERMS,
      semesterMappingNotes: [
        'Assumes July-start sessions: Sem1=Jul–Dec of enrollmentYear, Sem2=Jan–Jun following, etc.',
        'As of 2026-11-28: 2024 cohort current Sem5; 2023 cohort current Sem7; 2022 cohort finished Sem8 in Jan–Jun 2026 (COMPLETED).',
        'Active DEMO term: DEMO-IST-2026-27-S1.',
      ],
      planned: {
        coursesCreate: coursesToCreate.length,
        coursesReuse: coursesReuse.length,
        termsCreate: termsToCreate.length,
        termsReuse: TERMS.length - termsToCreate.length,
        offeringsCreate: offeringsToCreate.length,
        offeringsReuse: offeringsReuse.length,
        enrollmentsPlanned: plannedEnrollments.length,
        attendanceCreate: plannedAttendance,
        assessmentsCreate: plannedAssessments,
        scoresCreate: plannedScores,
        summariesCreate: plannedSummaries,
        predictionsCreate: 0,
        riskAlertsCreate: 0,
        teachersCreate: 0,
        usersCreate: 0,
      },
      expectedInsertCountsByTable: {
        Course: coursesToCreate.length,
        AcademicTerm: termsToCreate.length,
        CourseOffering: offeringsToCreate.length,
        Enrollment: plannedEnrollments.length, // upserts; first-run inserts ≈ this if none exist
        AttendanceRecord: plannedAttendance,
        Assessment: plannedAssessments,
        AssessmentScore: plannedScores,
        AcademicSummary: plannedSummaries,
        Teacher: 0,
        User: 0,
        Prediction: 0,
        RiskAlert: 0,
      },
      cohorts: byCohort,
      idempotentKeys: {
        Course: '@@unique([departmentId, code])',
        AcademicTerm: 'code @unique',
        CourseOffering: '@@unique([courseId, termId, section])',
        Enrollment: '@@unique([studentId, offeringId])',
        AttendanceRecord: '@@unique([studentId, offeringId, sessionDate])',
        Assessment: '@@unique([offeringId, name])',
        AssessmentScore: '@@unique([assessmentId, studentId])',
        AcademicSummary: '@@unique([studentId, termId, calculationVersion])',
      },
      warnings,
      ambiguities,
      conflicts: {
        predictionRowsWouldRemainUntouched: predictionCount,
        alertRowsWouldRemainUntouched: alertCount,
      },
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
