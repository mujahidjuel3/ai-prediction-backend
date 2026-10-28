# Step 3 — Main Frontend Real API Integration Report

**Date:** 2026-10-28  
**Project:** `ai-prediction` Main Frontend  
**Backend contract source:** `ai-prediction-backend/src` and Prisma schema  
**Verification boundary:** Static source/contract review, lint, typecheck and Next production build. No live API, authenticated database, or browser workflow was run.

## Executive summary

The Main Frontend no longer imports fixture data for any routed academic screen. A single typed API client now uses `NEXT_PUBLIC_API_BASE_URL`, credentialed cookies, CSRF tokens for mutations, one refresh-and-retry path for expired access cookies, and consistent API errors. Login/logout use that client.

Students now have an authenticated self-service dashboard and course/record views using only `/students/me`, `/students/me/records`, and recipient-scoped notifications. Teacher access to student/course/alert/prediction pages relies on the backend’s assigned-offering scopes. Admin access uses the backend’s Admin-allowed routes. The frontend adds no substitute authorization policy: the backend remains the security boundary.

Fabricated GPA/attendance trends, risk breakdowns, confidence, prediction accuracy, and static thresholds were removed from routed pages. The frontend shows only stored values and counts returned by current endpoints. Prediction generation remains truthfully unavailable. No backend, Admin Panel, ML, schema, or migration files were changed.

The root `ACADEMIC_SENTINEL_AUDIT_REPORT.md` was **not present** at the requested workspace path when this task began. The Step 1 and Step 2 reports were present and read. `DOMAIN_DECISIONS.md` was also reviewed; it explicitly defers prediction visibility, risk thresholds, attendance calculations, and GPA/mark rules to institutional decisions.

## Route-by-route status

| Route | Role access | Current data and behavior | Status / gap |
|---|---|---|---|
| `/` | All | Redirects to `/dashboard`. | **Connected but not live-verified** |
| `/login` | Public | Uses the existing login screen and shared API client; credentials are submitted to `POST /auth/login`; cookies are credentialed. | **Connected but not live-verified** |
| Dashboard layout / session gate | All | Calls `GET /auth/me`; API client attempts `POST /auth/refresh` after 401 and retries; role-based navigation and route checks; logout calls `POST /auth/logout`. | **Connected but not live-verified** |
| `/dashboard` — Student | Student | `GET /students/me`, `GET /students/me/records`, `GET /notifications?page=1&pageSize=5`; displays owned enrollments and record/message counts. A missing linked profile gets an explicit empty state. | **Connected but not live-verified** |
| `/dashboard` — Teacher | Teacher | `GET /analytics/summary`, `GET /alerts?page=1&pageSize=5`, `GET /courses`; all are statically confirmed teacher-scoped by backend handlers. | **Connected but not live-verified** |
| `/dashboard` — Admin | Admin | Admin-allowed summary, analytics, alerts and offerings endpoints. | **Connected but not live-verified** |
| `/students` | Admin, Teacher | Server-paged `GET /students?page=…&pageSize=25&q=…&sort=name&order=asc`; teacher list scope is enforced by backend. | **Connected but not live-verified** |
| `/students/[id]` | Admin, Teacher; Student only for own ID | Admin/Teacher use `GET /students/:id`, `GET /students/:id/records`, then attendance queries for offering IDs returned in the authorized profile. Student uses only `/students/me` and `/students/me/records`, and checks the requested ID against the returned self profile. | **Connected but not live-verified** |
| `/courses` | All roles | Student gets offerings from own `/students/me` enrollments; Teacher/Admin use `GET /courses` (teacher offerings are assigned-only). | **Connected but not live-verified** |
| `/courses/[id]` | All roles | Student filters their own `/students/me/records` by an offering found in their own profile. Teacher/Admin first verify the offering is in `GET /courses`, then read permitted enrollment, assessment, attendance and assessment-score endpoints. | **Connected but not live-verified** |
| `/alerts` | Admin, Teacher | Paged `GET /alerts`; status filter is sent to backend, severity filter applies to the currently loaded page. `PATCH /alerts/:id` supports acknowledge/resolve. | **Connected but not live-verified**; severity filtering is page-local |
| `/predictions` | Admin, Teacher | Reads `GET /predictions?page=1&pageSize=50`; displays stored model output and target metadata only. No generate action or demo accuracy/confidence is shown. | **Connected but not live-verified**; no pagination control |
| `/analytics` | Admin, Teacher | Uses `GET /analytics/summary` for student count, prediction count and persisted alert group counts only. | **Partially connected**; GPA/attendance/course trend aggregates are not available from the backend |
| `/notifications` | All roles | Paged recipient-scoped `GET /notifications`; `PATCH /notifications/:id/read` and `POST /notifications/read-all`. | **Connected but not live-verified** |
| `/settings` | All roles | `GET /users/me`, `PATCH /users/me/preferences`. Identity fields are read-only to avoid divergence from linked academic profiles. Email/weekly options are saved preferences only; delivery is not configured. | **Partially connected** |
| Loading/error/not-found states | All routes | Loading, empty, request, network, server, validation, 401/expired session, and 403 states are represented in client views or the shared API error handling. | **Connected but not browser-verified** |

Student roles are intentionally not offered the Students directory, staff alerts, staff analytics, or prediction history navigation. The backend also denies Student access to `/predictions`, `/alerts`, and staff offering endpoints. Student prediction and alert data is therefore described as unavailable rather than fetched through staff endpoints.

## API client and request handling

`lib/api.ts` is the sole runtime API transport for the routed Main Frontend.

- Uses `NEXT_PUBLIC_API_BASE_URL`; accepts either an API origin or a base already ending in `/api/v1`. No secret is placed in a frontend variable.
- Sends `credentials: "include"` and disables fetch caching for session/database-backed reads.
- Reads the readable `csrf_token` cookie and sends `X-CSRF-Token` on mutations. If a CSRF rejection is returned, refreshes the CSRF cookie and retries that request once.
- On an authenticated request’s 401, attempts the existing refresh-cookie endpoint and retries once. A final 401 signals the session gate to send the user to login.
- Parses the backend `{data, meta}` envelope and validation details. UI states distinguish configuration/network issues, 400/409 validation/conflict, 401, 403 and server failures.
- Login, profile reads, data reads, settings writes, alert updates, notification reads, and logout share this behavior.

No API response mapper creates GPA, attendance percentages, averages, risk labels, predictions, or other academic values. Typed response contracts are based on the inspected Nest controllers and Prisma relations. Paged requests preserve a single value for each pagination query key.

## Role and resource-scope findings

Confirmed from current backend source:

- `GET /students/me` and `GET /students/me/records` require Student role and resolve data from the authenticated `userId`.
- `GET /students/:id` and `GET /students/:id/records` enforce self-only Student access; Teacher detail and scores are filtered using the Step 1 assigned-offering scope.
- Teacher `GET /students` is filtered to active students enrolled in that Teacher’s assigned offerings.
- Teacher `GET /courses` returns only their assigned offerings. Enrollment, assessment and attendance handlers check assignment; assessment scores check the assessment’s offering.
- Teacher `GET /alerts`, `GET /predictions`, and analytics are scoped through currently enrolled students in assigned offerings. Student detail term-level predictions/alerts use the Step 1 conservative complete-term condition.
- `GET /notifications` and read mutations filter on the authenticated recipient.
- Staff/Admin API authorization remains authoritative. Frontend route checks improve navigation and messaging but do not replace backend guards.

The Teacher detail UI renders name, student number, department and academic fields returned by the scoped endpoint; it omits the student email because the audit/Step 1 report left teacher visibility of identity fields unresolved. The Student sees their own profile email.

## Actual backend contracts used

| Frontend operation | Endpoint(s) | Backend contract / scope |
|---|---|---|
| Session and logout | `GET /auth/me`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/csrf` | Cookie session; safe user identity; refresh rotation/revocation; CSRF cookie/token |
| Student dashboard and courses | `GET /students/me`, `GET /students/me/records` | Authenticated Student’s profile/enrollments and own attendance/scores |
| Student messages | `GET /notifications`, `PATCH /notifications/:id/read`, `POST /notifications/read-all` | Authenticated recipient only |
| Directory and detail | `GET /students`, `GET /students/:id`, `GET /students/:id/records` | Admin/Teacher directory; teacher-specific offering and record constraints; Student self-only by ID |
| Staff/admin courses | `GET /courses`, `GET /offerings/:id/enrollments`, `GET /offerings/:id/assessments`, `GET /attendance?offeringId=…[&studentId=…]`, `GET /assessments/:id/scores` | Admin or assigned Teacher, checked by the corresponding controller |
| Alerts | `GET /alerts?page=…&pageSize=…[&status=…]`, `PATCH /alerts/:id` | Admin/Teacher, Teacher list and mutation scope checked by backend |
| Prediction history | `GET /predictions?page=…&pageSize=…` | Admin/Teacher, Teacher records are scoped; Student role is not permitted |
| Analytics/dashboard | `GET /analytics/summary`, Admin-only use of `GET /dashboard/summary` | Scoped summary counts/groupings; dashboard summary avoided for Teacher because it includes global counts |
| Settings | `GET /users/me`, `PATCH /users/me/preferences` | Own identity and own stored notification preferences |

No backend endpoint was added or changed. Student prediction reads are not present or authorized. Prediction generation exists only as a 503 response until an approved trained model and policy are configured.

## Changed files

- `ai-prediction/app/(dashboard)/layout.tsx` — client session gate shell.
- `ai-prediction/app/(dashboard)/dashboard/page.tsx`, `students/page.tsx`, `students/[id]/page.tsx`, `courses/page.tsx`, `courses/[id]/page.tsx`, `alerts/page.tsx`, `analytics/page.tsx`, `predictions/page.tsx` — remove server fixture calls and use live views.
- `ai-prediction/app/(dashboard)/notifications/page.tsx` — new in-app notifications route.
- `ai-prediction/app/(dashboard)/error.tsx` — removes obsolete mock-data error copy.
- `ai-prediction/components/dashboard/live-dashboard.tsx` — role-aware API dashboard.
- `ai-prediction/components/students/students-view.tsx`, `student-detail-live.tsx` — paged directory and scoped detail/records.
- `ai-prediction/components/courses/courses-view.tsx`, `course-detail-live.tsx` — Student-owned courses and staff authorized offering workflows.
- `ai-prediction/components/alerts/alerts-view.tsx` — API alert list, filters and status changes.
- `ai-prediction/components/settings/settings-form.tsx` — authenticated identity and persisted preference controls.
- `ai-prediction/components/layout/dashboard-shell.tsx`, `header.tsx`, `sidebar.tsx` — session gate, role-aware navigation and shared logout.
- `ai-prediction/hooks/use-api-resource.ts` — shared typed API loading/error hook.
- `ai-prediction/lib/api.ts` — response types, API transport, CSRF/refresh/error behavior.
- `ai-prediction/lib/auth-client.ts` — reuses the shared API transport for login/logout.
- `ai-prediction/lib/nav.ts` — role permissions and Notifications route.

Pre-existing uncommitted changes were present in `.gitignore`, the dashboard layout/header, and login/auth files. Targeted layout/header/auth-client files were extended for this work; unrelated `.gitignore`, login UI, and `lib/auth.ts` changes were preserved. No Admin, backend, Prisma, migration, or ML files were changed. The old `lib/mock-data.ts` and unused legacy presentation components remain in the repository but are no longer imported by routed pages.

## Tests and exact checks

Main Frontend `package.json` provides `lint`, `typecheck`, and `build`; it has **no test script or test runner**. No automated response-mapping or browser test suite was available, and no new test dependencies were installed.

Run from `ai-prediction`:

| Command | Result |
|---|---|
| `npm.cmd run lint` | Passed, exit 0. One existing warning remains in `components/ui/avatar.tsx:27` for a raw `<img>`. |
| `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| `npm.cmd run build` | Passed, exit 0. Next.js generated all routes; dashboard data pages are dynamic. |
| `npm.cmd run` | Confirmed no test script is defined. |

The first sandboxed build attempt could not fetch the existing Google-hosted Geist fonts. After network permission was granted, the build passed. A later final build also passed with the fetched fonts available.

**Static contract verification:** checked frontend request paths, response envelopes and selected fields against the current Nest controllers and Prisma schema; checked role navigation against backend role decorators and resource predicates; `git diff --check` passed.

**Not performed:** automated frontend tests (no runner), backend tests (no backend files changed), live API calls, authenticated PostgreSQL checks, browser/E2E checks, process start/stop, migrations, seed, database writes, or deployment. Therefore API persistence, deployed CORS/cookies/CSRF, browser session refresh and visual behavior remain unverified.

## Known gaps and risks

- The Main Frontend cannot verify real persistence or cookie/CORS behavior until exercised against an authorized running API and database.
- Student prediction access and student alert reads are not exposed by the current backend. This implementation does not invent access.
- Prediction generation remains unavailable. No target, risk policy, confidence interpretation, or model accuracy is invented.
- The backend analytics endpoint provides counts and alert groups, not GPA/attendance/course trends. Those charts were removed from the live routes.
- Settings persists notification preference flags, but no email sender exists. UI explicitly says email/weekly preferences do not send mail.
- Profile identity is read-only in Main Frontend because `PATCH /users/me` updates the User while the academic profile synchronization behavior is not established. Admin manages academic profile identity.
- Alerts pagination is server-side; severity filtering is local to the current page. Prediction history currently displays the first 50 results without page controls. Courses use the backend’s unpaged offerings endpoint.
- The existing fixture module and legacy unused components remain, although routed pages no longer reference them.
- API base key is `NEXT_PUBLIC_API_BASE_URL`; its configured value was not read or printed in this task.

## Manual browser/API verification steps

Use only an approved local/test environment with synthetic records and accounts. Do not use real student records.

1. Configure `NEXT_PUBLIC_API_BASE_URL` to the API origin (or origin ending in `/api/v1`) and ensure backend CORS allows the frontend origin with credentials. Do not place secrets in a `NEXT_PUBLIC_*` variable.
2. Sign in as Admin. Open Dashboard, Students, Courses, Alerts, Predictions, Analytics, Notifications, and Settings; compare page fields and counts with the corresponding authenticated API responses. Refresh each route and confirm persisted data is reloaded.
3. Sign in as Teacher assigned to offering A, with a synthetic student enrolled in A and unrelated offering B. Search/open that student. Confirm only A enrollment, attendance, assessments, scores, and authorized term-level records appear. Open a B-only offering URL directly; confirm the API denies it and the UI displays the 403 state.
4. Sign in as a linked Student. Confirm Dashboard and Courses use only `/students/me` and `/students/me/records`; check recorded attendance/scores and Notifications. Change the URL to another synthetic student ID; confirm no other profile or records appear. Try staff routes and confirm role denial.
5. In Notifications, mark one and all messages read, refresh/relogin, and verify read state persisted. In Settings, change stored preference toggles, refresh/relogin, and verify they persist; confirm no email arrives.
6. Use an account with no records and one with no linked Student profile. Confirm truthful empty/unlinked states. With no stored predictions, confirm unavailable text and no KPI/confidence/risk demo values.
7. Let the access cookie expire while the refresh session remains valid and verify refresh/retry. Then expire/revoke both and confirm redirect to login. Sign out and verify the refresh session is revoked.
8. Confirm invalid credentials, unavailable API, validation errors and forbidden requests show actionable error states. Check narrow and wide viewports, keyboard navigation, and notification/alert controls.

The implementation is **verified by static contract review, lint, typecheck and build only**; it is not live API or browser verified.

