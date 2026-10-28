# Step 2 Account Linking Report

**Date:** 2026-10-28  
**Scope:** Admin-only linking/provisioning of Student and Teacher academic profiles to login accounts. No live database, browser, deployment, or real student records were used.

## Design and authorization rule

The Prisma schema already supports the relationship: `Student.userId` and `Teacher.userId` are nullable, unique foreign keys to `User`; `User.email`, `Student.studentNumber`, and `Teacher.employeeNumber` are unique. No migration was needed. Existing accounts can therefore be linked without changing schema or breaking unlinked profiles.

New profile creation requires an explicit `accountMode`:

- **CREATE:** create a User with the matching `STUDENT` or `TEACHER` role and the profile in one Prisma interactive transaction. Email is trimmed/lowercased; profile email mirrors account email. Password is Argon2id-hashed and never returned.
- **LINK:** link an existing active account of the exact matching role, provided it has no Student or Teacher profile already. Profile email is copied from that account; client-supplied email/password is rejected.
- Existing unlinked profiles can use dedicated `POST /students/:id/link-account` and `POST /teachers/:id/link-account` operations. Only active profiles can be linked. Both routes are Admin-only.
- Linkable-account lookup returns only active, unlinked accounts of the requested role and selects safe fields.
- Database uniqueness constraints and P2002-to-409 mapping prevent duplicate email, institutional identifier, and profile link. Database constraints remain the concurrency-safe authority.
- Linked account role changes that would mismatch the profile are rejected. Self-demotion/deactivation protections remain. Account/profile deactivation is synchronized; existing teacher-offering deactivation constraint remains in place.
- Production password-based account creation is denied. No invitation or password-reset delivery mechanism exists. Existing active accounts can be linked in production; provisioning a new account there requires a separately approved invitation/reset design.

The development-only setup path accepts an Admin-entered temporary password (14–128 characters). It is sent to the API over the configured authenticated/CSRF-protected flow, hashed with Argon2id, and not displayed again, returned, logged intentionally, or emailed. This is a local development setup mechanism only; it does not provide first-login password change, expiry, invitation delivery, or recovery. Do not use it for production or real student credentials. The Admin must arrange a secure out-of-band setup only in an approved development context; the app itself does not deliver credentials.

## Changed files

Backend:

- `ai-prediction-backend/src/institution/institution.controller.ts` — DTOs, linkable account lookup, transactional create/link workflows, active/role/duplicate checks, safe projections, synchronized status/profile fields, self/role protections and conflict mapping.
- `ai-prediction-backend/src/institution/institution.controller.spec.ts` — focused service/controller tests for account/profile pairing and constraints.
- `ai-prediction-backend/src/app.module.spec.ts` — HTTP-level Admin-only authorization coverage for provisioning/linking.

Admin frontend:

- `ai-prediction-admin/components/data/api-crud-view.tsx` — reusable conditional fields and account-link dialog/workflow; temporary password is masked and cleared after use.
- `ai-prediction-admin/components/students/students-view.tsx` — Student create/link payload and existing-profile link action.
- `ai-prediction-admin/components/teachers/teachers-view.tsx` — Teacher create/link payload and existing-profile link action.
- `ai-prediction-admin/components/users/users-view.tsx` — documents local-development-only password setup and links account setup to profile workflows.
- `ai-prediction-admin/types/student.ts`, `ai-prediction-admin/types/teacher.ts`, `ai-prediction-admin/types/user.ts` — request and safe linkable-account types.

No Prisma schema or migration change was made. Existing unrelated working-tree changes were preserved. No files in the Main Frontend or ML service were changed.

## Admin workflow

On Students or Teachers, select **Create account** to create the profile and matching-role account atomically (development only), or **Link existing account** to choose an active matching-role unlinked account. Existing unlinked profiles expose a **Link account** action. Profile creation in link mode requires the account choice; profile email is derived from the selected account. The Users screen can still manage unlinked development accounts, but cannot create password-based accounts in production. Password inputs are masked and cleared following the request.

## Tests added

- Transactional Student account/profile creation returns safe User fields and does not return password/hash.
- Duplicate email and duplicate institutional identifier produce conflict behavior; a profile failure does not leave the paired User committed under the transaction contract.
- Wrong-role account linking is rejected.
- Duplicate profile link and inactive account linking are rejected.
- Existing active Teacher account can be linked to an existing unlinked profile transactionally.
- A linked Student account cannot be changed to Teacher role; self-demotion guard remains.
- HTTP test confirms Teacher cannot create a Student account or use the Student account-link route.
- Existing suite also exercises auth/CSRF and role behavior.

Fixtures use synthetic identifiers and mocked Prisma. The rollback assertion uses an isolated transaction mock; it is not a real PostgreSQL rollback test.

## Verification results

Commands run from the applicable app directories:

| Application | Command | Result |
|---|---|---|
| Backend | `npm.cmd run lint` | Passed, exit 0 |
| Backend | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0 |
| Backend | `npm.cmd run test -- --no-cache` | Passed: **7 suites, 49 tests**, exit 0 |
| Backend | `npm.cmd run build` | Passed, exit 0 |
| Admin | `npm.cmd run lint` | Passed, exit 0 |
| Admin | `npm.cmd run typecheck -- --incremental false` | Passed, exit 0 |
| Admin | `npm.cmd run build` | Passed, exit 0 after rerunning with network access for the existing Google-hosted Geist font dependency. Initial sandboxed attempt could not fetch the font. |

Builds generated the normal backend `dist` and Admin `.next` outputs. The Admin build noted that the app reads its local environment file; no environment values were printed or inspected for this report.

Verification is **static code review, automated backend tests, lint/typecheck, and production builds only**. No live API, authenticated database, browser workflow, persistence-after-relogin, or production credential-delivery check was performed. No migration, seed, database mutation, process start/stop, or deployment was performed.

## Remaining risks and manual checks

- Verify create and link flows against an isolated disposable PostgreSQL database, including rollback after a profile constraint failure and persistence after refresh/relogin.
- In a browser, verify Admin CSRF cookie/header synchronization, session refresh, server validation errors, linkable-account filtering, profile edit behavior, and password field clearing. These were not browser-tested.
- Confirm the institution’s approved account invitation/reset procedure before production provisioning. Until it exists, production CREATE is intentionally blocked.
- Confirm whether synchronizing profile email/name on edits and synchronizing active status in both directions match the institution’s account lifecycle rules.
- Generic `POST /users` remains development-only for password-based setup. No frontend/main-app session regression or ML integration was tested because those are outside this step.
- Existing unlinked profiles remain valid; no automatic backfill/linking is attempted. An Admin must link each eligible profile explicitly.

## Recommended next checks

1. Run create/link, wrong-role, duplicate, deactivation, and post-login checks in an approved disposable database with synthetic records.
2. Browser-test Admin create and link flows under an Admin session, including CSRF and expired-session behavior.
3. Obtain approval for a production invitation/reset workflow before enabling production account creation.

