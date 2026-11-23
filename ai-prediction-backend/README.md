# Academic Sentinel API

NestJS modular monolith, PostgreSQL and Prisma. API prefix: `/api/v1`. Swagger UI (`/api/docs`) is enabled only when `NODE_ENV` is not `production`. Local development does not configure university production accounts or real student datasets.

## Requirements

- Node.js 20.19+ (Node 24 is also suitable) and npm
- PostgreSQL 16+ locally, or Docker Desktop if you choose the included Compose service
- Python 3.11/3.12 for the sibling `ai-prediction-ml` service

## PostgreSQL options

Direct local PostgreSQL: create a local database/user, then set `DATABASE_URL` to that local connection string. Do not reuse a university/production database for development.

Docker option (only after Docker Desktop is installed/running): in this directory set a local password in the shell and run `docker compose up -d postgres`. The password is supplied through the shell; the Compose file contains no credential. `docker compose down` stops it. Do not use `down -v` unless intentionally deleting this local database volume.

## API setup

```powershell
cd D:\Project\academic\ai-prediction-backend
npm.cmd install
Copy-Item .env.example .env
```

Edit `.env` locally. Generate `JWT_ACCESS_SECRET` and `ML_SERVICE_TOKEN` as independent random values of at least 32 characters; never commit `.env`. Set `DATABASE_URL`, and ensure development `CORS_ORIGINS` lists both frontend origins (`http://localhost:3000,http://localhost:3001`). Production requires `CORS_ORIGINS` to contain exactly `https://www.academicsentinel.live,https://admin.academicsentinel.live`, `COOKIE_SECURE=true`, and a valid private `ML_SERVICE_URL` URI. `DATABASE_URL`, `JWT_ACCESS_SECRET`, `ML_SERVICE_TOKEN`, and `CORS_ORIGINS` are required by startup validation. `PORT` defaults to 4000 and the service binds to `0.0.0.0`. Nest probes the ML service for Admin status and keeps prediction generation disabled until university gates pass; keep the ML host private. For existing databases use `npx prisma migrate deploy` (never `migrate reset` on shared data). `npm.cmd run prisma:seed` loads synthetic example records only and creates no login.

Bootstrap the first local Admin exactly once by temporarily setting `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (minimum 14 characters), and `BOOTSTRAP_ADMIN_NAME` in the process environment, then running `npm.cmd run bootstrap:admin`. The CLI refuses production mode and refuses if any Admin already exists. Remove the bootstrap values from the shell after use. There is no public admin-registration route.

Run `npm.cmd run start:dev`. Check `http://localhost:4000/api/v1/health/live`, `/api/v1/health/ready`, then inspect `http://localhost:4000/api/docs`.

## Current scope and known gaps

The first implementation checkpoint has auth/session primitives, role guards, health, student list/detail, term, department, course-offering read routes and dashboard summary. The domain Prisma schema is present, but migrations and the broader CRUD/records/import/prediction/notification APIs still need verification and completion. Student-facing prediction access is disabled by default. Do not connect the frontends to endpoints until their DTO mapping is implemented and tested.

## Academic-record CSV import

The authorized Admin preview route is `POST /api/v1/imports/academic-records/preview` with JSON `{ "csv": "...CSV text..." }` and an `Idempotency-Key` header. It accepts up to 5 MB/500 data rows with the exact headers in `docs/academic-records-template.csv`. `record_type=attendance` uses `record_date` and `attendance_status`; `record_type=score` uses assessment name/kind, max score, optional weight and score. Preview maps `student_number`, `course_code`, `term_code`, and section to existing active records and returns row-level errors. It creates no academic records. Commit uses `POST /api/v1/imports/:id/commit`; if preview contains invalid rows, the caller must send `acknowledgeInvalidRows: true` to explicitly commit only the preview's valid rows. Existing sessions/scores are never overwritten. Validated row IDs and values are staged in the import job until commit; define and implement an institutional retention/cleanup period before production use.

Student number, employee number, official grading/GPA formulas, attendance policy, alert policy and prediction target are institution decisions. See `../DOMAIN_DECISIONS.md`. No prediction endpoint will use a threshold substitute when the ML artifact is absent.

## Production packaging

- Container image: `Dockerfile` (Node 22). Entry: `node dist/main.js` after `npm run build` with `tsconfig.build.json`.
- Release DB step: `npx prisma migrate deploy` only (never `migrate reset` on shared/production data).
- Secrets template: `.env.production.example`. Frontends must not receive SMTP/JWT/DB secrets.
- Ops notes: `reports/PRODUCTION_OPS_RUNBOOK.md`.

## Optional email delivery for manual Admin messages

Email is disabled unless the institution has approved a manual-message consent/delivery policy and `EMAIL_POLICY_APPROVED=true`, then `SMTP_ENABLED=true` (transport master switch). The recipient must also have explicitly enabled the saved email notification preference; otherwise delivery is recorded as suppressed/skipped. Risk-alert email is not automated because target/risk/recipient/escalation policy has not been approved. Startup validation rejects enabling the transport without the policy approval flag.

`EMAIL_PROVIDER` selects the transport implementation:

- `smtp` (default): Nodemailer SMTP. For Gmail, set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER`, `SMTP_PASS` (preferred) or legacy `SMTP_PASSWORD` (App Password), `SMTP_FROM`, optional `SMTP_FROM_NAME`. Port 587 with `SMTP_SECURE=false` is supported for STARTTLS.
- `brevo`: Brevo Transactional Email API (`POST https://api.brevo.com/v3/smtp/email`) via native `fetch`. Set `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, optional `BREVO_SENDER_NAME`, optional `BREVO_TIMEOUT_MS` (default 15000).

Keep all email secrets server-side only; never put them in either frontend or any `NEXT_PUBLIC_*` variable. When the transport is enabled with `EMAIL_PROVIDER=smtp`, startup validation requires policy approval plus `SMTP_PASS` or `SMTP_PASSWORD`. When enabled with `EMAIL_PROVIDER=brevo`, it requires `BREVO_API_KEY` and `BREVO_SENDER_EMAIL`. When disabled, in-app messaging remains available.

A background email worker (`EMAIL_WORKER_ENABLED`, default true) drains leftover `PENDING` manual deliveries and can optionally auto-retry `FAILED` rows when `EMAIL_WORKER_AUTO_RETRY=true` (default false). Stuck `SENDING` rows older than `EMAIL_STALE_SENDING_MS` are marked `FAILED` with `STALE_SENDING` and are **not** automatically resent, to avoid duplicate emails after an ambiguous provider acceptance. Structured delivery actions are written to `AuditLog` without recipient addresses, message bodies, or credentials.

`SMTP_ACCEPTED` means the selected provider (SMTP or Brevo) accepted the message for processing. It does not confirm delivery to the recipient's inbox. Transient provider errors are retried up to `EMAIL_MAX_ATTEMPTS` (default 3); failures and safe error codes are persisted. Admins can retry a failed manual-message email from the Notifications page. Idempotency keys prevent repeat API submissions from creating or sending duplicate messages after an uncertain client response. Automated ML risk-alert email remains disabled until university approval. Do not switch production `EMAIL_PROVIDER` until explicitly approved.
