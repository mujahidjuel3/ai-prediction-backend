# Step 1 Security Report — Teacher Student-Data Scope

**Date:** 2026-10-28  
**Scope:** Fix and isolated regression tests for teacher authorization on student detail and records endpoints. No database or browser was used.

## Confirmed root cause

Before the fix, both handlers checked whether a teacher had *any* assigned course offering with an actively enrolled student. Once that check passed, `GET /students/:id` loaded every enrollment, term summary, prediction and alert for the student, and `GET /students/:id/records` loaded every score for that student (subject only to optional term filtering). The returned query was not restricted to the teacher’s offerings.

Evidence: `ai-prediction-backend/src/students/students.controller.ts`, previous handler query predicates; schema assignment path is `CourseOffering.teacher` plus `Enrollment.studentId/offeringId/status` in `prisma/schema.prisma`.

## Changed files

- `ai-prediction-backend/src/students/students.controller.ts` — derives teacher-authorized offering IDs from active enrollments and assigned offerings; filters detail relations and score reads.
- `ai-prediction-backend/src/students/students.controller.spec.ts` — added isolated controller regression coverage using mock Prisma calls and synthetic identifiers only.
- `reports/STEP_1_SECURITY_REPORT.md` — this report.

The existing frontend working-tree changes were inspected and left untouched. The backend folder has no Git repository metadata, so a backend Git diff/status is unavailable.

## Authorization rule after the fix

- **Admin:** retains unrestricted student detail and records behavior.
- **Student:** may request their own records only; a different student ID is denied.
- **Teacher:** may access a student only when there is an active enrollment joining that student to at least one offering assigned to the teacher. The detail response includes enrollment rows only for those assigned offering IDs; score reads are restricted to assessments for those offering IDs.
- **Term-wide data:** summaries, predictions and alerts are term-level in the schema, not offering-level. They are returned to a teacher only for a term where every enrollment of that student (including historical statuses) belongs to an offering assigned to that teacher. If an unassigned offering shares the term, term-wide data is omitted because it cannot safely be attributed to the permitted offering.
- **Identity fields:** the existing student identity/profile fields remain as before after the teacher passes the active-offering check. Whether teachers should see every field, particularly email, remains a product/privacy decision; this patch does not broaden identity access.

The detail handler does not currently expose attendance rows, and the records handler exposes scores only; the fix did not add either data category.

## Tests added and actual results

Six tests were added in `students.controller.spec.ts`:

1. Teacher with offering A and student also enrolled in unassigned offering B receives only A enrollment; same-term summaries, predictions and alerts are omitted.
2. Teacher score query is filtered to offering A, preserving permitted A access.
3. Teacher with no active assigned offering is denied before any score query.
4. Admin detail remains unrestricted and does not receive teacher filters.
5. Admin records remain unrestricted and do not receive teacher filters.
6. Student requesting another student’s records is denied before any score query.

All fixtures use synthetic IDs and mocked Prisma; no real student data is used.

Commands and results, run from `ai-prediction-backend`:

- `npm.cmd run lint` — passed (exit 0).
- `npm.cmd run typecheck -- --incremental false` — passed (exit 0).
- `npm.cmd run test -- --no-cache` — passed: **7 suites, 39 tests** (exit 0).
- `npm.cmd run build` — passed (exit 0).

The test command logs only use test-server fixtures; cookie and CSRF header values are redacted by the app logger. The build produced Nest generated output under `dist`.

## Verification boundary

**Verified:** source-level authorization predicates, isolated controller regressions, backend lint, TypeScript typecheck, automated tests and Nest build.

**Not verified:** live PostgreSQL contents/migration state, authenticated live API behavior, cookie/CORS deployment behavior, or browser rendering. No database reset/migration/seed/record mutation, process launch, deployment, package installation, credential read, or secret output was performed.

## Remaining risks and manual checks

- Run the endpoint checks against a disposable authorized test database once available: teacher assigned to A with a student in A+B should see A data only; a term summary/prediction/alert should be absent when B shares its term; an all-authorized term may show its term-wide aggregates.
- Confirm the intended teacher visibility of student-wide identity fields (especially email) with the product/privacy owner.
- Check whether withdrawn/historical enrollments should continue to suppress term-wide aggregates. Current conservative behavior considers every enrollment to avoid leaking aggregates derived from past unrelated course activity.
- Add HTTP-level tests for these student routes if an authenticated test fixture/database is introduced. Current new coverage is isolated at controller level; it does not exercise the global JWT/CSRF guards or Prisma execution.

The fix is **verified by automated tests and build only**, not by a live database or browser.

