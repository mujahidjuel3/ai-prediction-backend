# Step 6 — Alert Lifecycle and Email Delivery

**Date:** 2026-10-28  
**Scope:** NestJS notification/alert workflows, Prisma persistence, Admin message composition/history, and accurate recipient email-preference copy in the Main Frontend. No real email was sent; no database migration was applied.

## Executive summary

Manual Admin-authored messages now persist as in-app notification records and have a separate persisted SMTP delivery record. Optional email is attempted only when all three controls permit it: (1) institutional manual-email policy approval is explicitly configured server-side, (2) SMTP is enabled and completely configured server-side, and (3) the recipient’s saved email preference is true. In-app visibility follows the recipient’s in-app preference. Admin submissions require an idempotency key; an existing key returns the previous message/delivery state without sending again.

Delivery states distinguish `SUPPRESSED_PREFERENCE`, `SKIPPED_DISABLED`, `FAILED`, `SENDING`, and `SMTP_ACCEPTED`. Transient SMTP errors get up to three bounded attempts; failed manual-message emails can be retried by an Admin. `SMTP_ACCEPTED` means Nodemailer observed recipient acceptance from the SMTP provider and stores the provider message ID; it does **not** prove inbox delivery.

Automated risk-alert creation/escalation/email remains **blocked**. `DOMAIN_DECISIONS.md` and the Step 5 blockers report have no approved risk policy, recipient scope, or escalation rules. Existing alert status handling (acknowledge/resolve with audit log) remains available. A retry request for a notification linked to a risk alert is rejected. No ML/prediction email was added.

## Feature status

| Feature | Status | Evidence / boundary |
|---|---|---|
| Existing alert status lifecycle | **Partially verified** | `PATCH /alerts/:id` supports ACKNOWLEDGED/RESOLVED, teacher scope checks, resolved-state constraint and a transactional audit log in `src/workflows/workflows.controller.ts`. Mocked test suite runs; no live DB/browser status change tested. |
| Automated risk-alert creation/escalation | **Blocked** | No approved risk thresholds, recipients, escalation schedule, or consent policy in `DOMAIN_DECISIONS.md` / Step 5 report; existing controller has status update only. No automated generation was added. |
| Manual Admin in-app messages | **Partially verified** | `POST /notifications` persists a message, requires Admin role/CSRF and `Idempotency-Key`, applies recipient `inApp` preference, and returns a separate email status. Persistence is source/test verified only, not live DB verified. |
| Recipient in-app inbox/read state | **Partially verified** | `GET /notifications`, `PATCH /notifications/:id/read`, and `POST /notifications/read-all` remain recipient-scoped. Inbox now returns only `inAppVisible` notifications. Database persistence was not live-tested. |
| Optional manual-message SMTP | **Implemented, not live verified** | Nodemailer service uses only backend configuration. Startup requires `EMAIL_POLICY_APPROVED=true`, `SMTP_ENABLED=true`, SMTP credentials/from settings, and per-recipient email opt-in. No Gmail connection or actual email was sent. |
| Delivery status/history and retry | **Partially verified** | Admin-only `GET /notifications/email-deliveries` exposes persisted safe status fields; Admin can retry FAILED manual notifications via `POST /notifications/:id/email/retry`. Mocked tests only. |
| Risk-alert email | **Blocked** | No approved alert policy/recipient/escalation rules; retry endpoint rejects alert-linked messages. |
| Gmail login/registration, verification, recovery | **Not implemented** | SMTP credentials are not used for end-user authentication. No email verification or password-recovery workflow was added. |
| SMTP delivery confirmation | **Not available from SMTP response** | UI reports provider acceptance and message ID only; recipient inbox/spam-folder delivery is a manual Gmail check. |

## Design and changed files

### Backend

- `ai-prediction-backend/src/workflows/notification-email.service.ts` — server-only Nodemailer transport, preference/feature gates, bounded transient retries, safe status updates and retry protection for alert-linked records. SMTP failures store a constrained error code; message body, credentials, provider response text and recipient address are not logged.
- `ai-prediction-backend/src/workflows/workflows.controller.ts` — requires idempotency key for Admin manual messages, applies in-app/email preferences, creates notification plus delivery row, returns separate delivery evidence, adds Admin delivery history/retry routes, and hides notifications opted out of in-app delivery.
- `ai-prediction-backend/src/workflows/workflows.module.ts` — registers mail service and injectable Nodemailer transport factory.
- `ai-prediction-backend/src/app.module.ts` — startup validates SMTP settings and requires `EMAIL_POLICY_APPROVED=true` before `SMTP_ENABLED=true`; existing global authentication, CSRF, throttling, and log redaction remain.
- `ai-prediction-backend/prisma/schema.prisma` — adds `Notification.idempotencyKey`, `Notification.inAppVisible`, delivery statuses and one-to-one `NotificationEmailDelivery` state.
- `ai-prediction-backend/prisma/migrations/20261028153000_notification_email_delivery/migration.sql` — migration for idempotency/visibility fields and email-delivery status table/indexes. **Not applied to any database.**
- `ai-prediction-backend/.env.example` — adds SMTP/policy variable names with SMTP disabled and blank credential slots; no live `.env` was changed.
- `ai-prediction-backend/README.md` — Gmail setup, policy/preference gates, status semantics and retry caveats.
- `ai-prediction-backend/package.json`, `package-lock.json` — add Nodemailer and `@types/nodemailer`.
- `ai-prediction-backend/src/workflows/notification-email.service.spec.ts` — mocked transport coverage for disabled config, opt-out, success, transient retry, permanent failure, provider rejection, duplicate accepted event, and alert retry rejection.
- `ai-prediction-backend/src/workflows/workflows.controller.spec.ts` — repeated idempotency key does not create or dispatch a second event; alert retry delegation coverage.
- `ai-prediction-backend/src/app.module.spec.ts` — SMTP startup approval/config validation and Admin-only delivery history/CSRF/idempotency checks.

### Frontends

- `ai-prediction-admin/components/notifications/notifications-view.tsx` — sends idempotency keys, distinguishes in-app save from email status, shows SMTP acceptance wording and persisted delivery history, and offers retry for failed manual message delivery.
- `ai-prediction/components/settings/settings-form.tsx` — updates prior text that claimed no email was sent; explains opt-in, institutional approval, SMTP acceptance limitations, and that automated risk-alert email is disabled.

No SMTP credential, JWT secret, database URL, or other existing secret was changed or included in code/report. No frontend variable contains an SMTP secret.

## Configuration and operation

SMTP is off by default. Configure only the backend environment or server secret manager:

| Variable | Purpose |
|---|---|
| `EMAIL_POLICY_APPROVED` | Must be `true` only after the institution approves the manual-message email consent/delivery policy. Defaults to false. |
| `SMTP_ENABLED` | Must be `true` to attempt SMTP. Startup rejects true while policy approval is false. Defaults to false. |
| `SMTP_HOST` | Defaults to `smtp.gmail.com`. |
| `SMTP_PORT` | Defaults to `465`; `587` is also supported. |
| `SMTP_SECURE` | Defaults to `true` for implicit TLS on port 465; use `false` for STARTTLS on port 587. |
| `SMTP_USER` | Gmail mailbox address used by the backend transport. Required when SMTP is enabled. |
| `SMTP_PASSWORD` | Gmail App Password, stored only server-side. Required when SMTP is enabled. |
| `SMTP_FROM` | Sender email address. Required when SMTP is enabled. |

For Gmail, use a dedicated sending mailbox where possible, enable Google 2-Step Verification, then create an App Password if the account/Workspace policy allows it. Never use the account’s normal password. Some Workspace administrators disable SMTP/App Password access; that requires administrator approval or another approved provider. The sample configuration is in `ai-prediction-backend/.env.example`; actual `.env` files were not read or changed. Do not place these values in either frontend or any `NEXT_PUBLIC_*` variable.

Before setting the policy approval flag, the university must approve recipient consent wording, permitted message use, sender identity, retention, and whether an opt-in toggle is sufficient. Automated risk alerts additionally require a separate approved target/risk policy, recipients, escalation sequence, and review procedure; this code intentionally does not send them.

## Delivery and duplicate behavior

- The Admin client creates one random idempotency key per submission and retains it after an uncertain request failure so a retry can retrieve the same persisted event.
- The backend stores the key on the `Notification` unique column and creates its `NotificationEmailDelivery` row in the same DB transaction. The SMTP operation follows the transaction and never rolls back an already persisted in-app message.
- Email preference defaults false. If false, delivery state becomes `SUPPRESSED_PREFERENCE`; if SMTP is disabled, it becomes `SKIPPED_DISABLED`. In-app visibility is controlled separately by the saved in-app preference.
- Connection/greeting/socket timeouts are bounded. Connection reset/timeouts/DNS transient conditions and SMTP 4xx responses retry up to three attempts with short backoff. Permanent SMTP rejection records `FAILED`. Admin retry is allowed for FAILED manual messages only, after rechecking current email opt-in and server configuration.
- `SMTP_ACCEPTED` is set only when the SMTP library reports at least one accepted recipient. A provider message ID is persisted and shown. No delivery/read receipt is available from this SMTP flow.
- Application-level idempotency avoids a second send when a key is repeated and the event is already persisted. SMTP does not provide an exactly-once transaction spanning provider acceptance and PostgreSQL commit. If the process dies after SMTP acceptance but before status commit, the row can remain `SENDING`; it is deliberately not automatically resent because that could duplicate an email. Reconcile provider records before operationally retrying an ambiguous case.

## Tests and verification

Final checks run:

| Application | Command | Result |
|---|---|---|
| Backend | `npm.cmd run lint` | Passed, exit 0. |
| Backend | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Backend | `npm.cmd run test -- --no-cache` | Passed: **9 suites, 62 tests**, exit 0. Jest uses mocked Prisma/Nodemailer; no SMTP server or real recipient was contacted. |
| Backend | `npm.cmd run build` | Passed, exit 0. |
| Backend | `npm.cmd run prisma:generate` | Passed using schema only; generated local Prisma client. No database connection/migration. |
| Backend | `npx.cmd prisma validate` | Passed before the final app-config/test-only edits; Prisma schema did not change afterward. |
| Admin | `npm.cmd run lint` | Passed, exit 0. |
| Admin | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Admin | `npm.cmd run build` | Passed, exit 0; Notifications route generated. |
| Main frontend | `npm.cmd run lint` | Passed with one existing warning at `components/ui/avatar.tsx:27` about raw `<img>`; no errors. |
| Main frontend | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0. |
| Main frontend | `npm.cmd run build` | Passed, exit 0. |

`npm install nodemailer` and `npm install --save-dev @types/nodemailer` updated backend dependencies. npm reported **15 dependency vulnerabilities (8 low, 2 moderate, 5 high)** after install; no audit fix command was run.

Verification performed: static code review, Prisma schema validation/generation, mocked backend automated tests, and all three applications’ lint/typecheck/build checks. **Not performed:** database migration application, authenticated live API calls, Gmail SMTP login, actual email delivery, browser/E2E flow, live delivery-status persistence, or inbox/spam-folder verification. No processes were started or deployed.

## Security, remaining risks, and manual Gmail checks

- SMTP credentials remain server-side. Pino HTTP redaction rules remain in place; service code does not log message content, recipient address, SMTP password, raw provider error response, or provider response payload.
- Existing JWT/session/role/CSRF behavior is preserved; create/retry endpoints are Admin-only and protected by the global CSRF guard. Backend tests cover the notification mutation CSRF path and Admin-only history route.
- No email verification, password reset, or Gmail OAuth user login was added; those are separate authentication features and must not reuse SMTP credentials.
- The migration must be applied in a specifically authorized test database before any database-backed verification. Do not apply it to a shared/production DB as part of this report step.
- The persisted email history currently covers notification rows with delivery records. Existing historic notifications have no delivery row and are not retroactively emailed.
- Manual browser/Gmail verification, after policy approval and in a synthetic test environment: apply migration to an isolated DB; configure test sender credentials in the backend secret store; confirm SMTP startup fails when policy approval is false or required SMTP settings are missing; opt a synthetic recipient in/out; send a manual message; verify in-app visibility separately; confirm accepted response has a provider message ID but no inbox-delivered claim; test Gmail inbox/spam manually; simulate a transient provider failure and permanent rejection; confirm bounded attempts and persisted failure; retry failed message once; resubmit same idempotency key and confirm no duplicate; verify Student/Teacher cannot access Admin email history/retry route; test logout/expired session/CSRF rejection.

**Completion boundary:** manual-message email code and tests are implemented, but live SMTP delivery and database persistence are not verified. Risk-alert automation remains blocked on formal institutional policy and recipient/escalation decisions.
