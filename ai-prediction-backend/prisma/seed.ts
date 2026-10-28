import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// Synthetic development fixtures only. No logins or university records are seeded.
const prisma = new PrismaClient();
async function main() {
  const department = await prisma.department.upsert({ where: { code: 'DEMO-CSE' }, update: {}, create: { code: 'DEMO-CSE', name: 'Demonstration Computer Science' } });
  const now = new Date();
  const term = await prisma.academicTerm.upsert({ where: { code: 'DEMO-2026-FALL' }, update: {}, create: { code: 'DEMO-2026-FALL', label: 'Synthetic Fall Demonstration', academicYear: '2026-2027', startsAt: new Date('2026-09-01'), endsAt: new Date('2026-12-31'), active: true } });
  const course = await prisma.course.upsert({ where: { departmentId_code: { departmentId: department.id, code: 'DEMO 101' } }, update: {}, create: { code: 'DEMO 101', name: 'Synthetic Academic Data Example', departmentId: department.id, credits: 3 } });
  const offering = await prisma.courseOffering.upsert({ where: { courseId_termId_section: { courseId: course.id, termId: term.id, section: 'A' } }, update: {}, create: { courseId: course.id, termId: term.id, section: 'A' } });
  await prisma.student.upsert({ where: { studentNumber: 'SYNTHETIC-001' }, update: {}, create: { studentNumber: 'SYNTHETIC-001', name: 'Synthetic Demo Student', departmentId: department.id, enrollmentYear: 2026 } }).then(async student => {
    await prisma.enrollment.upsert({ where: { studentId_offeringId: { studentId: student.id, offeringId: offering.id } }, update: {}, create: { studentId: student.id, offeringId: offering.id } });
  });
  void now;
  console.log('Synthetic demonstration seed created. No account or real student data was added.');
}
main().finally(() => prisma.$disconnect());
