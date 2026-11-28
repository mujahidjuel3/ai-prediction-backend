-- Additive only. Existing rows are left unchanged.
-- CourseResult stores one weighted final result per enrollment.
-- AcademicSummary.cgpa is the cumulative CGPA as of that term.
-- AcademicSummary.cgpaBlockReason records why CGPA was withheld (including an unconfigured retake policy).

ALTER TABLE "AcademicSummary"
  ADD COLUMN "cgpa" DECIMAL(4,2),
  ADD COLUMN "cgpaBlockReason" VARCHAR(80);

CREATE TYPE "CourseResultStatus" AS ENUM ('CALCULATED', 'INCOMPLETE');

CREATE TABLE "CourseResult" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "courseId" UUID NOT NULL,
    "offeringId" UUID NOT NULL,
    "termId" UUID NOT NULL,
    "percentage" DECIMAL(6,2),
    "letterGrade" VARCHAR(4),
    "gradePoint" DECIMAL(3,2),
    "credits" DECIMAL(5,2) NOT NULL,
    "status" "CourseResultStatus" NOT NULL,
    "incompleteReason" VARCHAR(80),
    "calculationVersion" VARCHAR(40) NOT NULL,
    "calculatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseResult_enrollmentId_key" ON "CourseResult"("enrollmentId");
CREATE INDEX "CourseResult_studentId_termId_idx" ON "CourseResult"("studentId", "termId");
CREATE INDEX "CourseResult_studentId_courseId_idx" ON "CourseResult"("studentId", "courseId");

ALTER TABLE "CourseResult" ADD CONSTRAINT "CourseResult_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseResult" ADD CONSTRAINT "CourseResult_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseResult" ADD CONSTRAINT "CourseResult_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseResult" ADD CONSTRAINT "CourseResult_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CourseResult" ADD CONSTRAINT "CourseResult_termId_fkey" FOREIGN KEY ("termId") REFERENCES "AcademicTerm"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
