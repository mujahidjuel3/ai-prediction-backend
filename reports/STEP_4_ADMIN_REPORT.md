# Step 4 — Admin Panel Completion and Verification

**Date:** 2026-10-28  
**Scope:** Admin Panel (`ai-prediction-admin`) and its NestJS backend contracts (`ai-prediction-backend`). No database records, migrations, fixtures, credentials, or deployments were changed.

## Executive summary

The Admin Panel routes in the current worktree are API-backed and no longer use the removed fixture store. Existing authenticated API helpers use credentialed cookies, CSRF tokens for mutations, refresh/retry after 401, and typed API errors. List loading follows paginated `meta.totalPages`, so the Admin directory/report lists do not stop at the first 100 rows.

This step adds a backend-backed Academic Records CSV export using the existing Admin-only `GET /reports/academic-records.csv` contract, an optional term selector, downloaded row count, and session-refresh behavior for the download. It also prevents older concurrent list requests from replacing newer results and makes alert status actions report a successful mutation separately from a failed refresh.

Many workflows remain partial: term edit/archive APIs are absent; offering edit exists in the backend but is not exposed in the Admin UI; inactive Student records are omitted by the backend directory; several custom academic/notification/prediction actions do not yet prevent repeat submissions or clearly separate a successful write from a failed follow-up load. Department deletion is a constrained hard delete. These limitations are not represented as verified persistence because no database or browser workflow was run.

The original `ACADEMIC_SENTINEL_AUDIT_REPORT.md` was not present at the expected workspace path during this step. The Step 1, Step 2, and Step 3 reports and `DOMAIN_DECISIONS.md` were available and reviewed. The Admin worktree had extensive existing modifications and deletions before this step; those were preserved.

## Feature matrix

“Partially verified” means source contracts and/or automated checks support the behavior, but no live database or browser confirmation was performed. This report uses the requested statuses: **verified**, **partially verified**, **blocked**, **not implemented**.

| Route / feature | Status | Evidence and limits |
|---|---|---|
| `/login`, session and sign out | partially verified | `lib/api.ts`, `lib/auth-client.ts`, `lib/auth.ts`; API helper uses credentialed cookies, CSRF on writes, refresh retry. No browser/session-expiry test. |
| `/dashboard` | partially verified | `components/dashboard/dashboard-view.tsx` loads `/dashboard/summary` and `/analytics/summary`; shows database counts and explicitly unavailable prediction measures. Backend dashboard endpoint is role-guarded; Admin HTTP contract is exercised by backend tests, not live DB. |
| `/analytics` | partially verified | `components/analytics/analytics-view.tsx` loads `/analytics/summary`; only API aggregates are shown, with GPA/attendance/risk trends truthfully unavailable. |
| `/students` | partially verified | `components/students/students-view.tsx`, `components/data/api-crud-view.tsx`; paged list, profile edits, deactivation, create/link account. Backend `GET /students` and Admin `POST/PATCH/DELETE /students` exist. Backend listing currently filters to active profiles; there is no reactivation endpoint/UI. |
| `/students/[id]` | partially verified | `components/students/student-detail.tsx`; reads `/students/:id` and `/students/:id/records`; no mutation. Contract aligns to backend student detail. No live authorization check in this step. |
| `/teachers` | partially verified | `components/teachers/teachers-view.tsx`; paged profile CRUD and Step 2 account link/provisioning. `DELETE /teachers/:id` deactivates but returns conflict while offerings are assigned. No UI/browser persistence test. |
| `/departments` | partially verified | `components/departments/departments-view.tsx`; department CRUD and head-teacher field. `GET/POST/PATCH/DELETE /departments` exist; delete is a constrained hard delete and returns conflict when students/teachers/courses reference it. Head teacher options include all returned teachers, including inactive ones. |
| `/courses` catalog | partially verified | `components/courses/courses-view.tsx`; catalog `/courses/catalog`, POST/PATCH `/courses`, DELETE `/courses/:id` (archive). List is fully paged client-side; edit/archive exist. |
| Terms | partially verified | Same Courses route; `GET /terms` and `POST /terms` exist. No update/deactivate endpoint or UI. |
| Course offerings | partially verified | Same Courses route; list `/courses` and create `/offerings`; backend `PATCH /offerings/:id` exists but UI does not expose edit; no delete/archive route. |
| Enrollments / withdrawals | partially verified | Same Courses route; `GET /offerings/:id/enrollments`, `POST /offerings/:id/enrollments`, and `DELETE /offerings/:id/enrollments/:studentId` exist. Custom action currently reloads enrollments but does not refresh offering count, and duplicate-submit guards/refresh-failure distinction are incomplete. |
| `/academic-records` attendance, assessments, scores | partially verified | `components/records/records-view.tsx`; calls attendance POST/GET, assessments POST/GET, batch score POST/GET and CSV import preview/commit. Contracts exist and backend tests run, but no live persistence test. Some mutations report successful write before/without a separately verified full refresh. |
| `/academic-records` CSV import | partially verified | Preview via `POST /imports/academic-records/preview` and commit via `POST /imports/:id/commit`; Admin guard, validation, idempotency key and transaction/audit code exist. No DB mutation tests were run in this step. |
| `/users` role management | partially verified | `components/users/users-view.tsx`; `GET /users`, Admin `POST/PATCH/DELETE /users`; linked Student/Teacher role changes are constrained and self-demotion/deactivation blocked in backend. UI may offer a role change that backend correctly rejects for linked accounts. Password account creation remains development-only. |
| `/alerts` | partially verified | `components/alerts/alerts-view.tsx`; loads paged `/alerts` and PATCHes status. This step adds duplicate-action protection plus distinct mutation/refresh feedback. No live data test. |
| `/predictions` history/reviews | partially verified | `components/predictions/predictions-view.tsx`; reads paged `/predictions`, writes review via `/predictions/:id/reviews`; generation is explicitly unavailable without approved model/policy. Review uses browser prompts and has no explicit in-flight duplicate guard. |
| `/notifications` | partially verified | `components/notifications/notifications-view.tsx`; `/notifications`, `/users`, POST `/notifications`, PATCH read and POST read-all. Backend persists in-app notification only. Recipient/data loading and repeat-action feedback need refinement; no SMTP or realtime delivery. |
| `/reports` directory CSV | partially verified | `components/reports/reports-view.tsx`; client export uses fully loaded paged Student/Teacher data and departments. Row count is reported. Not a backend-generated export endpoint. |
| `/reports` academic records CSV | partially verified | Added here: calls backend `GET /reports/academic-records.csv` with optional termId through cookie-authenticated download/401 refresh; counts CSV data rows; displays endpoint’s 5,000-row limit. No live API/database/browser verification. |
| `/settings` profile/preferences | partially verified | `components/settings/settings-view.tsx`; GET/PATCH `/users/me` and PATCH `/users/me/preferences`. No SMTP delivery behind email preference. Controls currently lack robust duplicate-submit/save-refresh handling. |

No feature is marked fully verified because this turn did not run browser tests or a live API/database workflow.

## Architecture and responsibilities

- **Admin frontend:** Next.js 16.3.1 App Router, React 19.2.8, TypeScript 5. Shared CRUD/table/forms live under `components/data` and `components/ui`; API/session transport in `lib/api.ts`, auth flow in `lib/auth-client.ts` and `lib/auth.ts`, paginated list aggregation in `lib/use-api-list.ts`.
- **Backend:** NestJS 11.1, TypeScript 5.9, Prisma 6.19. Controllers/services are organized into auth, students, academic, institution, workflows, imports, reports and health modules. Global JWT/role guards and CSRF middleware apply as configured.
- **Database:** PostgreSQL through Prisma. Current migration directory contains `20261026120000_initial`; this Step 4 made no schema or migration changes.
- **No ML, Redis, Socket.IO, or mail provider was added or used by the Admin Panel in this step.** The backend has prediction history/review persistence and a generation route that returns unavailable until approved model/policy configuration. Notification records are in-app database rows.

Architecture: `Admin Panel → credentialed NestJS API → Prisma → PostgreSQL`. Student and Teacher frontends are separate applications and are not modified by this step.

## Admin API contract map

All responses below use `{ data: ... }`; paged responses also include `meta: { page, pageSize, total, totalPages }`. Admin access is enforced by JWT plus Admin role on write/admin-only routes. Read endpoints that also permit Teacher are scoped in backend queries. Request DTO names are recorded where identifiable from controller decorators; exact validation is implemented server-side with global DTO validation.

| Admin operation | Backend contract / request | Implementation status |
|---|---|---|
| Login/session | `GET /auth/csrf`; `POST /auth/login` (`LoginDto`); `GET /auth/me`; `POST /auth/refresh`; `POST /auth/logout` | Implemented. HttpOnly access/refresh cookies; CSRF required for writes. |
| Summary | `GET /dashboard/summary`; `GET /analytics/summary` | Implemented. Counts/alert groups and stored prediction count; no GPA/risk formula. |
| Students | `GET /students?page&pageSize&q`; `GET /students/:id`; `GET /students/:id/records`; `POST /students` (`StudentDto`); `PATCH /students/:id` (`StudentUpdateDto`); `DELETE /students/:id`; `POST /students/:id/link-account` (`AccountProvisioningDto`) | Implemented, with active-only list behavior. Admin profile deactivation; no reactivation route. |
| Teachers | `GET /teachers?page&pageSize&q`; `POST /teachers` (`TeacherDto`); `PATCH /teachers/:id` (`TeacherUpdateDto`); `DELETE /teachers/:id`; `POST /teachers/:id/link-account` (`AccountProvisioningDto`) | Implemented; deactivation refused while any offering remains assigned. |
| Linkable accounts/users | `GET /users/linkable?role=STUDENT|TEACHER`; `GET /users?page&pageSize&q`; `POST /users` (`UserDto`); `PATCH /users/:id` (`UserUpdateDto`); `DELETE /users/:id` | Implemented. Safe projections omit hashes; production password-based create blocked; role/link/self safeguards apply. |
| Departments | `GET /departments`; `POST /departments` (`DepartmentDto`); `PATCH /departments/:id` (`DepartmentUpdateDto`); `DELETE /departments/:id` | Implemented. Delete rejects referenced department; success is physical delete. |
| Terms | `GET /terms?page&pageSize`; `POST /terms` (`TermDto`) | List/create only. No update/archive/delete endpoint. |
| Courses/catalog | `GET /courses/catalog?page&pageSize&departmentId`; `POST /courses` (`CourseDto`); `PATCH /courses/:id` (`CourseUpdateDto`); `DELETE /courses/:id` (sets active=false) | Implemented. |
| Offerings | `GET /courses?termId&departmentId`; `POST /offerings` (`OfferingDto`); `PATCH /offerings/:id` (`OfferingUpdateDto`) | API create/edit/list. Admin UI currently only creates/list; no offering deletion endpoint. |
| Enrollment | `GET /offerings/:id/enrollments`; `POST /offerings/:id/enrollments` (`EnrollDto`); `DELETE /offerings/:id/enrollments/:studentId` | Implemented. Withdrawal changes status to WITHDRAWN. |
| Attendance | `GET /attendance?offeringId&studentId`; `POST /attendance` (`AttendanceDto`) | Implemented; assigned-offering authorization for Teachers; upsert key includes student/offering/date. |
| Assessments/scores | `GET /offerings/:id/assessments`; `POST /assessments` (`AssessmentDto`); `GET /assessments/:id/scores`; `POST /assessment-scores/batch` (`ScoresDto`) | Implemented; Teacher offering authorization and active enrollment/max-score checks. Batch upserts run transactionally. |
| Alerts | `GET /alerts?status&page&pageSize`; `PATCH /alerts/:id` (`AlertUpdateDto`) | Implemented. Teacher-scoped; resolved alert cannot be reopened through this operation; update/audit transaction. |
| Predictions | `GET /predictions?termId&page&pageSize`; `POST /predictions/:id/reviews` (`ReviewDto`); `POST /predictions/generate` | History/reviews implemented and Teacher-scoped. Generation deliberately returns 503 until trained model/risk policy exists. |
| Notifications | `GET /notifications?unread&page&pageSize`; `POST /notifications` (`CreateNotificationDto`, Admin); `PATCH /notifications/:id/read`; `POST /notifications/read-all` | Persistent in-app only, recipient-scoped reads. No email/realtime. |
| Profile/preferences | `GET /users/me`; `PATCH /users/me` (`ProfileDto`); `PATCH /users/me/preferences` (`PreferencesDto`) | Implemented for authenticated account. Preference persistence does not send email. |
| Import | `POST /imports/academic-records/preview` (`PreviewDto`, Idempotency-Key); `GET /imports/:id`; `POST /imports/:id/commit` (`CommitDto`) | Implemented. Preview/commit scoped to creating Admin; commit transaction checks enrollments and writes attendance/scores/audit. |
| Export | `GET /reports/academic-records.csv?termId` | Implemented, Admin-only. Combines attendance and score rows; rejects combined result >5,000. No directory export endpoint exists. |
| Health | `GET /health/live`; `GET /health/ready` | Implemented; readiness executes `SELECT 1`. Not called in this step to avoid contacting an unconfirmed local DB. |

### Frontend/backend gaps

- No backend endpoint supports term edit/archive; no Admin UI control can safely provide those operations.
- Offering edit is available as `PATCH /offerings/:id`, but the UI has no edit workflow. No offering deletion/archive endpoint exists.
- Student directory contract filters status `ACTIVE`; inactive Student profiles therefore cannot be browsed/reactivated from the current UI/API pair.
- Directory CSV is client-generated from all API pages; no directory CSV endpoint exists. Academic CSV is now server-generated and has an explicit 5,000 combined-row limit.
- `/courses` is unpaged in the backend and returns all matching offerings. The Admin hook accepts its raw array response.
- Backend DTO/controller status and test coverage do not establish browser behavior or database persistence in this run.

## Pagination, filtering, validation, and persistence review

`lib/use-api-list.ts` requests page 1 and then all `meta.totalPages`; each view’s `pageSize=100` is a per-request size, not an overall record cap. It now uses a request generation counter so a slower, earlier reload cannot replace results from a later request. Generic CRUD search/sorting and ten-row table pagination operate over the fully loaded client list. Backend paging helper validates integer page/pageSize; API HTTP tests include duplicate page/pageSize returning 400, while frontend URL construction uses `URLSearchParams.set` to prevent duplicate parameters.

List search/sort are local after loading; backend Student/Teacher APIs support `q`, but current generic CRUD lists do not send changing search terms to the server. Status/category filtering is not consistently exposed. Academic CSV uses optional server `termId`; UI does not calculate performance scores.

CRUD save/link/deactivate currently checks list reload result and distinguishes the successful write from failed refresh. Alert update now also prevents concurrent per-list actions and reports a write separately from reload failure. Enrollment, attendance/assessment/score, notification mark-read, prediction review, and settings paths still need a consistent duplicate-action guard and explicit post-write refresh outcome. No actual refresh/relogin persistence was verified.

## Security/session findings

- `lib/api.ts` sends `credentials: "include"`, obtains CSRF token from `/auth/csrf`, supplies `X-CSRF-Token` on mutation, refreshes once after eligible 401, retries a recognized CSRF failure once, and maps 400/401/403/5xx/network errors.
- `apiDownload` added in this step uses the same credentialed cookie and refresh helper for the backend CSV GET, does not expose any token, and maps non-2xx JSON API errors. It is not mutation-capable and does not bypass Admin route guards.
- Backend auth routes set HttpOnly access/refresh cookies; CSRF cookie is readable for double-submit synchronization; Pino redaction covers cookie, authorization, CSRF request header and Set-Cookie paths. CSRF and authorization were not live-tested.
- Admin writes use backend role checks; linked profile roles and self-demotion/deactivation are protected by backend checks, evidenced in `src/institution/institution.controller.ts` and its unit/HTTP tests.
- No secrets or environment values are included here. Backend configuration schema requires `DATABASE_URL`, `JWT_ACCESS_SECRET`, `CORS_ORIGINS`, and `ML_SERVICE_TOKEN`; only key presence/configuration is relevant to source review. No `.env`/`.env.local` value was included in this report.

## Database and migration status

Prisma schema and initial migration are present (`ai-prediction-backend/prisma/schema.prisma`, `prisma/migrations/20261026120000_initial`). Existing Step 2 reports that the nullable unique `Student.userId` and `Teacher.userId` relations already support account linking. This step changed no Prisma schema and created no migration. No migration status command or DB connection was run; whether the current local database has applied the migration is **unable to verify**. No records were created, changed, or deleted.

## UI/UX and known workflow gaps

- Existing Academic Sentinel design and responsive components were retained; no browser/visual test was performed.
- Generic CRUD forms use browser-native required/type constraints plus field checks and display backend errors; shared API maps validation details. Custom flows differ in error semantics, duplicate submission protection, and refresh reporting.
- Notifications are persisted in-app messages. No SMTP/Gmail, verification, recovery mail, retry/delivery status, real-time transport or duplicate-email logic exists in the current Admin/backend integration.
- Prediction review currently uses `window.prompt` for outcome/rationale. Review outcome remains backend-validated, but the form is not inline and repeat submissions are not explicitly disabled.
- Department head selector does not filter inactive teachers; Student listing only returns active profiles. No reactivation mechanism is available.
- Settings page allows email/weekly preferences but does not send mail; current UI should be treated as stored preference only.
- Accessibility, keyboard workflow, responsive browser layout, focus/error announcement, CSV download in browsers, and cross-origin cookie behavior remain manual checks.

## Verification results

Commands were run after the targeted changes, from each application folder:

| Application | Command | Result |
|---|---|---|
| Admin | `npm.cmd run lint` | Passed, exit 0. |
| Admin | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Admin | `npm.cmd run build` | Passed, exit 0; Next generated `/dashboard`, `/analytics`, `/students`, `/students/[id]`, `/teachers`, `/departments`, `/courses`, `/academic-records`, `/users`, `/alerts`, `/predictions`, `/notifications`, `/reports`, `/settings`, `/login`, and shell routes. |
| Admin | `npm.cmd run` / package script inspection | No test script or configured test runner; Admin tests not available. |
| Backend | `npm.cmd run lint` | Passed, exit 0. |
| Backend | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Backend | `npm.cmd run test -- --no-cache` | Passed: 7 suites, 49 tests, exit 0. Jest/Supertest tests use mocks/isolated app instances and synthetic fixtures; request logs show redacted cookie/CSRF headers. Not a live DB mutation test. |
| Backend | `npm.cmd run build` | Passed, exit 0. |
| Main frontend | Checks | Not run; outside Step 4 scope and unchanged. |

Verification classes:

- **Static source/contract inspection:** performed across Admin routes, API helpers, backend controllers, DTO usage, Prisma schema and migration directory.
- **Automated backend tests:** run; 49 passed, using isolated mocked test contexts.
- **Admin automated tests:** unavailable; no test script/runner.
- **Build/lint/typecheck:** Admin lint/typecheck/build passed; backend lint/test/build passed; backend typecheck skipped this turn.
- **Read-only live API checks:** not performed; no API process was started or contacted.
- **Authenticated database checks/mutation tests:** not performed; no database was connected or changed.
- **Browser/E2E checks:** not performed; no browser/process was started.
- **`git diff --check`:** reports trailing whitespace/extra blank EOF lines in the pre-existing modified Admin files `components/analytics/analytics-view.tsx`, `components/records/records-view.tsx`, `components/settings/settings-view.tsx`, and `components/students/student-detail.tsx`. Those files were not changed during Step 4; their worktree edits were preserved. The Step 4-edited API, list, alert and report files did not appear in those warnings.

## Migration details

No migration was needed or created. No Prisma schema or backend file was modified in Step 4. Build outputs are generated artifacts under normal ignored build directories; existing unrelated modifications were preserved.

## Manual browser/API steps

Use an approved local environment with synthetic records and an authorized Admin session; do not use real student data.

1. Sign in as Admin, load Dashboard and Analytics, and compare displayed counts/groupings to `/dashboard/summary` and `/analytics/summary` responses.
2. Test Students/Teachers create and link workflows with synthetic accounts; confirm invalid/duplicate email, wrong role, inactive account, and duplicate-link errors are shown. Refresh and relogin to verify persistence. Confirm production account creation remains blocked unless using approved invitation workflow.
3. Create/edit/deactivate a Teacher and test deactivation conflict while assigned to an offering. Verify inactive Student visibility limitation and department-head selection behavior.
4. Create/edit/archive a Course, create a Term and Offering, enroll then withdraw a synthetic Student, refresh the route, and verify persistence. Verify offering edit remains unavailable in UI pending implementation.
5. Record attendance, create an assessment, save scores, reload the offering view and verify database values; test score-above-maximum, non-enrolled Student, duplicate session attendance, expired session and CSRF retry.
6. Upload a synthetic CSV; inspect preview/errors, commit valid rows with explicit invalid-row acknowledgment when needed, refresh/relogin and confirm persisted rows and accurate committed/skipped counts. Confirm repeated job commit is rejected.
7. Update alert state and prediction review; verify list refresh and audit/persisted state. Confirm prediction generation remains unavailable and no fabricated risk/confidence values appear.
8. Send an in-app notification to a synthetic account, mark one/all read, refresh and relogin; verify recipient scoping/read state. Confirm no email or realtime delivery is claimed.
9. Export Student/Teacher/Department directories and verify row counts across multiple backend pages. Export academic records without a term, then with a term; verify CSV headers, data row count, filter scope, and expected 5,000-row rejection behavior.
10. Test profile/preferences save, expired access-cookie refresh, revoked session, 401/403/400/5xx/network errors, keyboard navigation and narrow viewport layout.

## Prioritized remaining work

### P0 — Security / critical correctness

- **Add live authorized CSRF/session/browser verification.** Why: automated mocks do not prove deployed cookie SameSite/CORS/CSRF synchronization or refresh behavior. Affected: `ai-prediction-admin/lib/api.ts`, backend auth/CSRF config. Dependency: safe local environment and synthetic Admin account. Acceptance: browser confirms login, mutation, single refresh retry, logout/revocation, 401/403 behavior without token leakage. Phase: verification hardening.
- **Test role/resource authorization with a database-backed fixture.** Why: API mock tests cannot prove Prisma scope across real relation queries. Affected: backend student/workflow/institution controllers. Dependency: isolated disposable PostgreSQL test DB. Acceptance: Admin full allowed operations, Teacher assigned-offering-only operations and Student self-only behavior pass integration tests. Phase: backend integration coverage.

### P1 — Core Admin CRUD and account functionality

- **Expose offering edit using existing endpoint.** Why: Admin cannot correct course, term, teacher or section once created. Affected: `components/courses/courses-view.tsx`, `PATCH /offerings/:id` (`OfferingUpdateDto`). Dependency: decide which fields may change after enrollments/records exist; backend constraints are currently not visibly checked. Acceptance: edit form sends DTO-compatible values, displays validation/conflict, persists after reload and does not orphan academic records. Phase: Admin CRUD completion; review backend invariants first.
- **Add safe inactive Student discovery/reactivation workflow.** Why: deactivated profile disappears from active-only `GET /students`, and no reactivation path exists. Affected: backend Student query/update contract and Admin Students view. Dependency: confirm reactivation/account active-state behavior. Acceptance: Admin can find inactive profile and atomically restore profile/account under defined rules; no existing academic history removed. Phase: Admin lifecycle workflow.
- **Improve custom operation busy/error handling.** Why: duplicate attendance/score/notification/review calls and unclear refresh outcomes undermine operator confidence. Affected: `components/courses/courses-view.tsx`, `components/records/records-view.tsx`, `components/notifications/notifications-view.tsx`, `components/predictions/predictions-view.tsx`, `components/settings/settings-view.tsx`. Acceptance: controls disable during write, show field/server errors, and separately state write success vs subsequent list refresh failure. Phase: mutation feedback consistency.

### P2 — Academic workflow, persistence, reporting and completeness

- **Define term lifecycle API/UI.** Why: currently terms are create/list only; no edit/archive is possible. Affected: `src/academic/academic.controller.ts`, Admin Courses view. Dependency: policy for changes to terms referenced by offerings/records. Acceptance: safe updates are validated, referenced-term constraints are explicit, and no history is deleted. Phase: backend contract then Admin workflow.
- **Refresh offering counts after enrollment mutations and filter inactive selectors.** Why: offering row enrollment count can be stale; Teacher selector includes inactive rows. Affected: `components/courses/courses-view.tsx`. Acceptance: post-write reload refreshes both enrollments and offering count; options include only active profiles where contract provides status. Phase: Admin workflow refinement.
- **Add backend directory CSV endpoint if complete export needs server snapshot/filter semantics.** Why: current directory export assembles paginated client reads that can span concurrent data changes and has no server-side filters. Affected: backend reports module and Admin Reports. Dependency: define supported filters and snapshot/row limits. Acceptance: export query and displayed row count match the server-selected filtered dataset. Phase: reporting completeness.
- **Standardize server-side filtering/search/pagination UI.** Why: current generic CRUD loads every row, then applies local search/sort/page; this can grow expensive and search contract differs by entity. Affected: `lib/use-api-list.ts`, `components/data/api-crud-view.tsx`, list views and backend DTOs. Acceptance: stable page/filter/sort parameters, no duplicate query keys, consistent totals, and preserved query state. Phase: Admin data scale.

### P3 — ML policy, automated alerts, and messaging integrations

- **Keep predictions unavailable until approved target/model/policy is established.** Why: no trained model/risk policy can support real prediction generation. Affected: backend workflows/ML integration and Predictions UI. Dependency: approved target, dataset governance, training/evaluation plan, risk thresholds and owner (see `DOMAIN_DECISIONS.md`). Acceptance: versioned reproducible model, leakage-safe evaluation and persisted metadata before inference is enabled. Phase: separate ML design/implementation step.
- **Define alert generation and notification delivery policy.** Why: current persisted alerts are not automatically generated by model inference; in-app messages do not send email/realtime. Affected: backend workflows and notification UI. Dependency: approved trigger/escalation/consent policy and delivery provider. Acceptance: idempotent alert creation, delivery status/retry, recipient preferences and observable logs with no duplicate sends. Phase: separate integration step.

### P4 — Accessibility, performance and release readiness

- **Browser accessibility/responsiveness/performance pass.** Why: compile checks do not measure screen reader, keyboard, focus, responsive, large-directory or download behavior. Affected: all Admin routes/components. Dependency: browser and synthetic environment. Acceptance: keyboard-only CRUD and errors, accessible labels/focus announcements, narrow/large viewport checks, and measured acceptable load/export performance. Phase: UX hardening.

## Recommended phased implementation plan

1. Establish an isolated disposable PostgreSQL integration environment and add role/resource persistence tests without using or cleaning up existing records.
2. Complete safe Admin lifecycle workflows: offering edit with backend invariants; inactive Student discovery/reactivation; term lifecycle after policy approval.
3. Standardize custom mutation state and verify reload/relogin persistence for academic records, notifications, alerts, reviews, and settings.
4. Decide directory export filtering/snapshot requirements and add a backend endpoint only if needed; verify CSV filters/row counts and limit UX.
5. Conduct Admin browser verification for CSRF, refresh, role restrictions, validation, error states, accessibility and responsive behavior.
6. Keep ML, automated risk alerts, email/realtime delivery and deployment in separately approved steps after domain decisions; preserve existing unrelated work and avoid broad refactoring.
