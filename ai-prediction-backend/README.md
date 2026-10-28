# Academic Sentinel API

NestJS modular monolith, PostgreSQL and Prisma. API prefix: `/api/v1`; Swagger UI: `/api/docs`. This is a local development setup. No AWS, paid API, university dataset, real users, or production account is configured.

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

Edit `.env` locally. Generate `JWT_ACCESS_SECRET` and `ML_SERVICE_TOKEN` as independent random values of at least 32 characters; never commit `.env`. Set `DATABASE_URL`, and ensure development `CORS_ORIGINS` lists both frontend origins (`http://localhost:3000,http://localhost:3001`). Production requires `CORS_ORIGINS` to contain exactly `https://www.academicsentinel.live,https://admin.academicsentinel.live`, `COOKIE_SECURE=true`, and a valid `ML_SERVICE_URL` URI. `DATABASE_URL`, `JWT_ACCESS_SECRET`, `ML_SERVICE_TOKEN`, and `CORS_ORIGINS` are required by startup validation. `PORT` defaults to 4000 and the service binds to `0.0.0.0`. `ML_SERVICE_URL` currently has no backend source-code consumer; its production value remains to be determined and the ML service must not be exposed publicly. Apply a schema migration with `npm.cmd run prisma:migrate -- --name init`, then `npm.cmd run prisma:seed` for clearly synthetic example records. Seed data creates no login.

Bootstrap the first local Admin exactly once by temporarily setting `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` (minimum 14 characters), and `BOOTSTRAP_ADMIN_NAME` in the process environment, then running `npm.cmd run bootstrap:admin`. The CLI refuses production mode and refuses if any Admin already exists. Remove the bootstrap values from the shell after use. There is no public admin-registration route.

Run `npm.cmd run start:dev`. Check `http://localhost:4000/api/v1/health/live`, `/api/v1/health/ready`, then inspect `http://localhost:4000/api/docs`.

## Current scope and known gaps

The first implementation checkpoint has auth/session primitives, role guards, health, student list/detail, term, department, course-offering read routes and dashboard summary. The domain Prisma schema is present, but migrations and the broader CRUD/records/import/prediction/notification APIs still need verification and completion. Student-facing prediction access is disabled by default. Do not connect the frontends to endpoints until their DTO mapping is implemented and tested.

## Academic-record CSV import

The authorized Admin preview route is `POST /api/v1/imports/academic-records/preview` with JSON `{ "csv": "...CSV text..." }` and an `Idempotency-Key` header. It accepts up to 5 MB/500 data rows with the exact headers in `docs/academic-records-template.csv`. `record_type=attendance` uses `record_date` and `attendance_status`; `record_type=score` uses assessment name/kind, max score, optional weight and score. Preview maps `student_number`, `course_code`, `term_code`, and section to existing active records and returns row-level errors. It creates no academic records. Commit uses `POST /api/v1/imports/:id/commit`; if preview contains invalid rows, the caller must send `acknowledgeInvalidRows: true` to explicitly commit only the preview's valid rows. Existing sessions/scores are never overwritten. Validated row IDs and values are staged in the import job until commit; define and implement an institutional retention/cleanup period before production use.

Student number, employee number, official grading/GPA formulas, attendance policy, alert policy and prediction target are institution decisions. See `../DOMAIN_DECISIONS.md`. No prediction endpoint will use a threshold substitute when the ML artifact is absent.

## Optional SMTP delivery for manual Admin messages

Email is disabled unless the institution has approved a manual-message consent/delivery policy and `EMAIL_POLICY_APPROVED=true`, then `SMTP_ENABLED=true`. The recipient must also have explicitly enabled the saved email notification preference; otherwise delivery is recorded as suppressed/skipped. Risk-alert email is not automated because target/risk/recipient/escalation policy has not been approved. Startup validation rejects enabling SMTP without the policy approval flag.

For a Gmail mailbox, configure `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` as the sender mailbox, `SMTP_PASSWORD` as a Google App Password (Google account 2-Step Verification is required), and `SMTP_FROM` as the sender email address. Port 587 with `SMTP_SECURE=false` is also supported for STARTTLS. Keep all these settings in the backend's server-side environment only; do not put them in either frontend's `NEXT_PUBLIC_*` variables or commit credentials. When SMTP is enabled, the backend validates all required settings at startup. When disabled, the existing in-app workflow remains available.

`SMTP_ACCEPTED` means the SMTP server accepted the message for processing. It does not confirm delivery to the recipient's inbox. Transient SMTP errors are retried up to three attempts; failures and safe error codes are persisted. Admins can retry a failed manual-message email from the Notifications page. Idempotency keys prevent repeat API submissions from creating or sending duplicate messages after an uncertain client response. As with SMTP generally, an ambiguous network failure after provider acceptance cannot provide a mathematical exactly-once delivery guarantee; reconcile persisted status before retrying such a case.
