# Academic Sentinel — Final Integration Audit

**Date:** 2026-10-28  
**Scope:** Main Frontend (`ai-prediction`), Admin Panel (`ai-prediction-admin`), NestJS API (`ai-prediction-backend`), and Python ML service (`ai-prediction-ml`).  
**Change boundary:** Audit only. No source, environment, schema, or database files were changed during Step 7. This report is the only new file.

## 1. Executive summary

The project has three built frontend/API applications with API-backed routed pages, a NestJS/PostgreSQL/Prisma backend, and a Python FastAPI/training skeleton. Backend lint, typecheck, tests, build, and Prisma schema validation pass. Main and Admin frontend lint/typecheck/build pass; Main lint reports one existing raw-`img` warning. Backend tests are isolated/mock based. Frontend package scripts provide no test runner. Python 3.12.10 is present, but `pytest` is not installed, so ML tests could not run.

The read-only Prisma migration status check found two migrations and reports `20261028153000_notification_email_delivery` pending. It was not applied. This is a confirmed integration blocker: current notification code expects the new email-delivery table/fields, so notification creation/delivery-history calls against this database are not ready until the migration is applied in an approved environment. No database records were read or changed.

The project still has no approved university ML dataset, target, cutoff/horizon, risk thresholds, alert recipients/escalation policy, or model artifact. Prediction generation remains a backend 503, and there are no actual model metrics. Automated risk alerts and risk-alert email are therefore blocked. Manual Admin-authored message email code is present but remains unverified against PostgreSQL or Gmail; policy approval and SMTP are both off by default in code/config defaults.

The original `ACADEMIC_SENTINEL_AUDIT_REPORT.md` is absent at the workspace root. All six `reports/STEP_*_REPORT.md` phase reports and `DOMAIN_DECISIONS.md` were reviewed. Existing uncommitted Main/Admin changes were preserved. The backend directory does not expose Git metadata in this workspace, so backend working-tree status cannot be independently summarized here.

No browser, live authenticated API, Gmail, model inference, or student-record workflow was run. The database check was limited to Prisma migration metadata against a loopback-configured PostgreSQL target.

## 2. Feature matrix across applications

Status definitions: **Verified** means the available static or automated evidence directly verifies that layer; it does not imply live browser/database behavior. **Partially verified** means source and/or mock tests/build support it, but integration behavior remains unverified. **Blocked** means a required migration, policy, data, or runtime prerequisite is missing. **Missing** means no implementation exists in the inspected scope.

| Feature | Main Frontend | Admin Panel | Backend | Python ML | Overall evidence/status |
|---|---|---|---|---|---|
| Build/runtime routes | **Verified (build)** | **Verified (build)** | **Verified (build)** | **Partially verified** | Next route builds pass; Nest build passes; Python source inspected but pytest unavailable. |
| Authentication/session | **Partially verified** | **Partially verified** | **Partially verified** | N/A | Cookie/CSRF/refresh code and backend auth/role tests exist; no browser expiration/revocation check. |
| Admin/Teacher/Student isolation | **Partially verified** | **Partially verified** | **Partially verified** | N/A | Step 1 offering-scope unit regressions and backend role tests use mocks; no authenticated live/API+DB role matrix. |
| Student/Teacher profile-account linking | N/A for Main workflows | **Partially verified** | **Partially verified** | N/A | Step 2 atomic create/link code and mock tests exist; no actual PostgreSQL rollback or refresh/relogin persistence check. |
| Main academic pages | **Partially verified** | N/A | **Partially verified** | N/A | Routed dashboard/student/course/alerts/analytics/settings/notification pages call APIs; no `mock-data` imports were found in routed dashboard sources. No live response mapping/browser verification. |
| Admin CRUD and academic records | N/A | **Partially verified** | **Partially verified** | N/A | Admin routes call real API contracts; backend endpoints/tests exist. Persistence across refresh/relogin was not tested. Several feature gaps are listed below. |
| CSV import/export | N/A | **Blocked for current DB / partially verified in code** | **Blocked for current DB / partially verified in code** | N/A | Preview/commit and directory/API export code exists. Pending Step 6 migration affects notification schema; no real CSV upload or export was executed. |
| Notification delivery | **Partially verified** | **Blocked for current DB / partially verified in code** | **Blocked for current DB / partially verified in code** | N/A | In-app/read workflows exist; optional manual-message SMTP code/tests exist. Current local database lacks the new delivery migration. No live SMTP. |
| Alert lifecycle | **Partially verified** | **Partially verified** | **Partially verified** | N/A | Status update/resolve and audit transaction in backend; no policy-based generation, automation, or live persistence check. |
| Prediction generation/history | **Blocked** | **Blocked** | **Blocked** | **Blocked** | History/review contracts/UI are present, but generation returns 503; no approved target/data/model/policy. No prediction metrics. |
| Email verification/password recovery/Gmail login | **Missing** | **Missing** | **Missing** | N/A | SMTP is a message transport only; these separate identity workflows were not implemented. |

## 3. Verified, partially verified, blocked, and missing features

### Verified at source/build/test level

- NestJS backend source passes lint, typecheck, tests and build; 9 suites / 62 tests pass in this audit. Tests include role guard, CSRF, teacher scope, account-linking constraints, notification policy/config checks, mocked SMTP outcomes/retries and idempotency behavior.
- Main and Admin Next.js production builds emit their current routes. Main and Admin typechecks pass. Main lint passes with one raw `<img>` warning in `components/ui/avatar.tsx:27`; Admin lint passes cleanly.
- Prisma schema validates. The migration status command reached the loopback-configured database and reported the initial migration applied and the Step 6 notification-delivery migration pending.
- Main routed dashboard source statically calls the typed API client. It does not import the removed fixture module; no mock-data/fixture identifier was found in the routed dashboard source search.
- Step 1 code restricts Teacher student detail and score queries to assigned offerings. Automated tests cover A/B offering isolation, Admin access, and Student self-only access using synthetic IDs/mocked Prisma.
- Step 2 code provisions/links matching-role accounts transactionally with safe projections, duplicate/active/role protections, and tests; these are not database integration tests.

### Partially verified

- Cookie credentials, CSRF request handling, refresh-and-retry, and role checks are supported by static review and mocked backend tests. Deployed CORS, browser cookies, expiry/refresh, and logout revocation are unverified.
- Main/API and Admin/API response contracts are source-mapped against current controllers. No real authenticated API response was obtained in this audit.
- Student/Teacher/department/course/term/offering/user/record CRUD and notification settings are present to varying degrees. No authenticated persistence-after-refresh/relogin workflow was run.
- Manual Admin messages maintain an idempotency key, in-app visibility preference, opt-in email preference, and persisted email delivery status in code. SMTP is not live verified and the database migration is pending.
- CSV import preview/commit and CSV export are implemented in source; no synthetic CSV was uploaded or downloaded in browser/live API.

### Blocked

- **ML training/inference:** no authorized dataset/provenance, target definition, observation unit, cutoff/horizon, feature availability contract, approved risk thresholds/intended use, or release criteria are recorded. No model artifact exists. The Python README explicitly says no university data/model/metrics are included. Backend `POST /predictions/generate` deliberately returns 503.
- **Automated risk alert generation/email:** risk policy, recipient scope, and escalation rules are not approved. Existing alert status changes do not provide automated alert generation.
- **Current local notification schema:** `20261028153000_notification_email_delivery` is pending in the configured loopback DB. The migration was not applied. Current notification delivery endpoints may fail against this DB until schema deployment is explicitly approved and performed.
- **Python test verification:** `python -m pytest -q` fails because pytest is not installed. No package install was performed.

### Missing/incomplete

- Admin terms are list/create only; there is no term update/archive API/UI.
- Backend supports offering `PATCH`, but Admin UI does not expose editing. There is no offering delete/archive endpoint.
- Student directory currently returns active Student records; there is no inactive Student discovery/reactivation workflow.
- Admin directory CSV export is assembled client-side from paged APIs; no backend directory CSV endpoint exists.
- Main Predictions page shows a fixed first 50 records without page controls (Step 3 report); student prediction access remains unavailable by design.
- Admin custom academic-record, notification, prediction-review and settings operations have incomplete or inconsistent duplicate-submit and post-write refresh-failure feedback (Step 4 report).
- There is no automated job/worker for background email retries or alert escalation. Email uses synchronous bounded retries then Admin retry.
- There is no live Gmail inbox delivery evidence, no delivery/read receipt, and no email verification/password recovery flow.

## 4. Commands run and actual results

### Backend / Prisma

| Command | Result |
|---|---|
| `npm.cmd run lint` (`ai-prediction-backend`) | Passed, exit 0. |
| `npm.cmd run typecheck -- --incremental false` (`ai-prediction-backend`) | Passed, exit 0. |
| `npm.cmd run test -- --no-cache` (`ai-prediction-backend`) | Passed: 9 suites, 62 tests, exit 0. Mocked test suite; no student records or SMTP were used. |
| `npm.cmd run build` (`ai-prediction-backend`) | Passed, exit 0. |
| `npx.cmd prisma validate` | Passed; Prisma schema is valid. |
| `npx.cmd prisma migrate status` | Read-only status reached local loopback PostgreSQL: 2 migrations found; `20261028153000_notification_email_delivery` is pending. No migration was applied. |

### Frontends

| Application | Command | Result |
|---|---|---|
| Main | `npm.cmd run lint` | Passed with one existing warning: raw `<img>` in `components/ui/avatar.tsx:27`; zero errors. |
| Main | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Main | `npm.cmd run build` | Passed, exit 0. |
| Admin | `npm.cmd run lint` | Passed, exit 0. |
| Admin | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Admin | `npm.cmd run build` | Passed, exit 0. |

Neither frontend package has a test script or configured test runner; frontend automated tests were unavailable.

### Python ML

| Command | Result |
|---|---|
| `python --version` (`ai-prediction-ml`) | Python 3.12.10. |
| `python -m pytest -q` | Not run: command exits 1 with `No module named pytest`. Dependencies were not installed. |

### Checks deliberately not run

- No browser/E2E automation, live authenticated HTTP workflow, database record query, mutation, seed, reset, or migration apply.
- No Gmail SMTP login/send. Configuration and policy flags were not read from real secret files; no SMTP secret was printed or changed.
- No ML training, inference, model artifact creation, dataset opening, or model metrics. Step 5 gate remains unsatisfied.
- No frontend test command because neither frontend defines one.
- `git diff --check` on Admin reports whitespace/extra blank EOF lines in four pre-existing modified files (`components/analytics/analytics-view.tsx`, `components/records/records-view.tsx`, `components/settings/settings-view.tsx`, `components/students/student-detail.tsx`). These were not changed in Step 7 and were preserved. Main `git diff --check` produced no whitespace findings.

## 5. Security and privacy findings

- No secrets, email credentials, database URL, tokens, or private student rows are included in this report. Main/Admin Next build logs indicated `.env.local` was loaded, but its values were not displayed or read for this report.
- Backend cookie/CSRF/role guards and Pino redaction are present. Automated tests cover role guard ordering, CSRF mismatch, account provisioning restrictions, and teacher scope at mocked/controller level. Browser/session and database-backed resource isolation remain unverified.
- Step 1’s offering A/B scope fix is present. Teacher term-wide summaries/predictions/alerts remain conservatively hidden when the student has an unrelated offering in that term; student identity field visibility is still a product/privacy decision.
- Step 2 account linking validates active matching-role account, unique links and transactional pairing in code. Tests use mocks; no live PostgreSQL transaction/rollback or persistence test was performed.
- Step 6 SMTP transport is server-only; SMTP is disabled by default and blocked by `EMAIL_POLICY_APPROVED=false` unless policy is affirmatively approved. Per-recipient email opt-in is required. Raw provider errors/message bodies/recipients are not intentionally logged. No real Gmail connection was tested.
- SMTP `SMTP_ACCEPTED` is provider acceptance, not inbox delivery. SMTP cannot guarantee exactly-once behavior if a process stops between provider acceptance and recording state; status can remain `SENDING` for reconciliation.
- Read-only migration status was run only after confirming the configured database host resolves to loopback. It queried migration metadata; no student data or data rows were queried.

## 6. ML model details and measured metrics

No model/version/artifact or institutional evaluation metrics exist in the inspected project. `ai-prediction-ml/train.py` is a generic binary-classification training skeleton with baseline, Logistic Regression and Random Forest candidates, temporal/group/stratified split options, preprocessing, and metric generation. Its README explicitly distinguishes its synthetic examples from authorized university data. The FastAPI service returns `MODEL_REQUIRED` without local artifact/metadata. Backend generation remains an unconditional 503 until the model and policy are approved.

No dataset was opened and no metrics were produced. Required owner decisions remain listed in `reports/STEP_5_ML_BLOCKERS_REPORT.md` and `DOMAIN_DECISIONS.md`.

## 7. Email and alert delivery verification

- **In-app notification source status:** API persistence/read/unread routes and Admin message UI are implemented; mock tests cover contract behavior. Current local DB is missing the delivery migration, so full current-schema integration is blocked.
- **Email status:** SMTP code and mocked transport tests exist; SMTP configuration is policy-gated and disabled by default. No SMTP server was contacted, no Gmail credentials were inspected, and no message was sent. No inbox delivery is claimed.
- **Risk alerts:** status acknowledgement/resolution are implemented with audit logging. Automatic alert creation, recipient selection, escalation, and alert email are not enabled because the domain policy is not approved.
- **No Gmail login, registration, verification or password-recovery workflow exists.** SMTP credentials are not used for user authentication.

## 8. Known issues and reproduction steps

### P1 — Notification delivery migration is pending

**Evidence:** `npx.cmd prisma migrate status` found the initial migration and reported `20261028153000_notification_email_delivery` unapplied. The current backend uses `Notification.idempotencyKey`, `Notification.inAppVisible` and `NotificationEmailDelivery` in `src/workflows/workflows.controller.ts` and `src/workflows/notification-email.service.ts`.

**Effect:** Inference from the known schema drift: notification creation and email delivery-history queries against this database can fail because the expected column/table is not present. No request was sent to reproduce this, to avoid a failing authenticated mutation against live local data.

**Safe reproduction after explicit test-DB approval:** use a disposable local PostgreSQL database with only the initial migration; authenticate as a synthetic Admin; send a valid CSRF-protected `POST /api/v1/notifications` with a unique `Idempotency-Key`; observe server failure before the new migration, then apply the migration only to that disposable DB and repeat. Verify one notification/delivery row and repeat the same key to check no duplicate.

### P2 — Python tests unavailable in current environment

**Evidence/reproduction:** `python --version` reports 3.12.10; `python -m pytest -q` exits 1 because module `pytest` is missing. No dependency installation was attempted. Set up the declared ML requirements in an isolated Python environment and rerun pytest only after owner approval; this does not satisfy dataset/policy prerequisites for training.

### P2 — Admin lifecycle and list workflow gaps

- Terms remain create/list only; offering edit endpoint exists without Admin UI; inactive Students lack discovery/reactivation workflow. Evidence: Step 4 route/controller matrix and current Admin components.
- Main prediction history displays a fixed first 50 entries without page controls. Evidence: Step 3 report.
- These are incomplete features, not regressions fixed in this audit; no broad changes were made.

### P4 — Existing quality/docs issues

- Main lint warning at `components/ui/avatar.tsx:27` for raw `<img>`.
- Admin `git diff --check` shows pre-existing whitespace warnings in the four named modified files; no formatting cleanup was done to preserve unrelated changes.
- Backend README has older scope language that predates the completed CRUD/notification steps and should be reviewed in a documentation-only pass.

## 9. Deployment readiness checklist

- [ ] Apply and verify the pending notification migration in an authorized isolated DB; confirm existing data remains intact.
- [ ] Run authenticated Admin create/link/CRUD/import/export workflows against synthetic data; verify persistence after refresh/relogin.
- [ ] Browser-test Admin/Teacher/Student role boundaries, assigned-offering isolation, cookies, CSRF, refresh/logout and validation/error states.
- [ ] Obtain university approval for ML dataset provenance, exact target/cutoff/horizon/features, risk thresholds, intended use, alert recipients and escalation.
- [ ] Keep prediction generation disabled until a model is trained/evaluated, policy signed off, and inference/persistence tests pass.
- [ ] Approve email consent/sender/retention policy; configure SMTP only via backend secrets; confirm Gmail provider acceptance and inbox behavior in a controlled synthetic test.
- [ ] Decide handling/reconciliation for ambiguous `SENDING` email records and monitor delivery failures.
- [ ] Install pytest only in an isolated ML environment and run Python unit tests; do not train without approved data.
- [ ] Review npm-reported dependency vulnerabilities from the Step 6 Nodemailer install and schedule a separate dependency-security review; no audit fix was run in this audit.
- [ ] Complete browser accessibility, responsive, performance, logging/monitoring, backup/restore and deployment-secret checks.

**Readiness:** Not ready for production deployment. Blocking items are pending migration, unverified database/browser behavior, unapproved ML/risk policy, absent model/data, and unverified SMTP delivery.

## 10. Remaining work in priority order

### P0 — Security/data integrity

1. Apply and verify the Step 6 migration in an authorized disposable DB before running notification mutations; test rollback/duplicate handling and existing record preservation.
2. Complete database-backed tests for account linking transactions and Teacher offering scope; then browser-test role/resource boundaries and cookie/CSRF/session flows using synthetic data.

### P1 — Core operations

3. Verify Student/Teacher link/provision, Admin CRUD, course enrollment, attendance/scores, alerts, notifications, CSV import/export, and settings persistence across refresh/relogin in the isolated test database.
4. Complete Admin inactive Student handling and offering edit; define term lifecycle constraints before adding term update/archive.
5. Improve consistent mutation duplicate guards and refresh-failure reporting for Admin custom workflows.

### P2 — Integration/report completeness

6. Decide whether directory exports need a backend snapshot/filter endpoint; add only if required by approved operational needs.
7. Add frontend automated tests for API response mapping, role views, idempotent notification submission, and error/expired-session behavior.
8. Run the ML Python tests in an isolated environment; verify FastAPI token/feature-schema behavior with synthetic fixtures.

### P3 — ML and automated early warning

9. Obtain authorized dataset provenance and university decisions for target, cutoff/horizon, feature availability, validation design, acceptable metrics, risk policy, intended use and human review.
10. Train only after approvals; record reproducible holdout metrics, calibration/fairness limits, model version and artifacts. Add authenticated backend inference/persistence and tests only after sign-off.
11. Approve alert recipients/escalation and consent policy before automated alert generation or email.

### P4 — Release quality

12. Perform real browser QA/accessibility/responsive/performance checks, review dependency vulnerabilities, update stale docs, configure production secrets/origins/TLS/logging/backup/monitoring, and conduct a deployment rehearsal.

**No Step 7 implementation fixes were made.** Existing workspace changes were preserved; no services were started, no data was modified, and nothing was deployed.
