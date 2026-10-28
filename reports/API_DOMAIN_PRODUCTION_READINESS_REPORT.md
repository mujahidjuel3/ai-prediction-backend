# API Domain Production Readiness Report

**Date:** 2026-10-28  
**Scope:** Local code/configuration review only. No deployment or external service changes.

## Summary

Both frontends now share a consistent `NEXT_PUBLIC_API_BASE_URL` contract. It is a full API base URL with `/api/v1` included, and each API client normalizes URLs so the prefix appears exactly once. Production URL validation requires HTTPS and rejects localhost/loopback. The API remains configured at `https://api.academicsentinel.live/api/v1`.

The NestJS service validates the browser origins, requires secure cookies in production, retains the `/api/v1` prefix, and still binds to `0.0.0.0`. The production CORS allowlist is exactly the two confirmed frontend origins.

This report does not establish that DNS, the API, AWS, Vercel, authentication, or browser cookies are live or working in production.

## Projects and files inspected

- `ai-prediction`: `package.json`, `next.config.ts`, `README.md`, `lib/api.ts`, `lib/auth.ts`, app routes and API call sites, `.gitignore`, and API URL/configuration references.
- `ai-prediction-admin`: `package.json`, `next.config.ts`, `lib/api.ts`, `lib/auth.ts`, `lib/auth-client.ts`, API call sites, `.gitignore`, and API URL/configuration references. This project had no README before this task.
- `ai-prediction-backend`: `package.json`, `.env.example` (template only), `src/app.module.ts`, `src/main.ts`, CSRF guard, health controller, Prisma schema, `README.md`, Docker Compose, and API/configuration references.
- `ai-prediction-ml`: `requirements.txt`, `README.md`, `app/main.py`, and local service URL/bind references.
- No `AGENTS.md` was found under the workspace. The workspace root is not a Git repository; the two Next.js projects are separate Git repositories. Their existing modified, deleted, and untracked files were preserved.
- No Vercel config, Dockerfile, or CI workflow was found in the four project trees (excluding dependencies/build outputs).

## Files changed for this task

- `ai-prediction/lib/api-url.ts` — URL validation and one-time `/api/v1` normalization.
- `ai-prediction/lib/api.ts` — route all fetches through the URL helper; retain CSRF, credentials, refresh/retry, and error behavior.
- `ai-prediction/lib/auth.ts` — server-side session lookup now uses the prefixed API URL.
- `ai-prediction/.env.example` — safe local API base URL example.
- `ai-prediction/README.md` — document local and production API configuration.
- `ai-prediction-admin/lib/api-url.ts` — matching URL validation and prefix normalization.
- `ai-prediction-admin/lib/api.ts` — all browser and server API requests use the helper; retain existing auth behavior.
- `ai-prediction-admin/.env.example` — safe local API base URL example.
- `ai-prediction-admin/README.md` — local and production configuration notes.
- `ai-prediction-backend/src/app.module.ts` — validate CORS origins for development/production and require secure cookies plus an ML URL in production.
- `ai-prediction-backend/README.md` — document production CORS and runtime requirements.
- `reports/API_DOMAIN_PRODUCTION_READINESS_REPORT.md` and `reports/VERCEL_ENV_SETUP_GUIDE.md`.

The `ai-prediction` and `ai-prediction-admin` repositories already contained many user changes, including modifications to `lib/api.ts`, `lib/auth.ts`, and other tracked/untracked files. Their complete pre-existing worktree changes are not attributed to this task and were not reset or discarded.

## API URL behavior

Before:

- Main API requests conditionally appended `/api/v1`, but `lib/auth.ts` fetched `/auth/me` directly from the configured URL and missed the prefix.
- Admin API requests concatenated paths directly, so it required callers/environment to supply a prefixed base URL without documenting or validating that contract.
- Missing values were deferred, but URL formats and accidental duplicate/missing prefixes were not handled consistently.

After:

- Both projects use `NEXT_PUBLIC_API_BASE_URL` as the full base URL, including `/api/v1`.
- Intended Vercel Production value for both: `https://api.academicsentinel.live/api/v1`.
- The helper accepts either the API origin or a base URL ending exactly in `/api/v1`, then adds/removes the prefix as needed exactly once. Other path suffixes, malformed URLs, credentials, query strings, and fragments are rejected at request time.
- In production, the URL must use HTTPS and cannot target localhost or loopback. The setting is checked when a request is made, so a missing value does not fail static page generation/build.
- `/api/v1` is added by the frontend URL helper. The environment value shown above already includes the prefix, and normalization prevents duplication.

The variable is `NEXT_PUBLIC_*` because these browser clients need the API origin; it contains no secret. Backend credentials remain server-side.

## Backend CORS, cookies, CSRF, refresh, and health

- `src/main.ts` still sets the global `api/v1` prefix, enables credentialed CORS using `CORS_ORIGINS`, applies cookie parsing and existing security middleware, and listens on `0.0.0.0` using `PORT` (default 4000).
- Production `CORS_ORIGINS` must contain exactly `https://www.academicsentinel.live,https://admin.academicsentinel.live`. Each entry must be an exact HTTPS origin; wildcard, malformed, duplicate, unconfirmed, and apex origins fail startup validation. Development is limited to `http://localhost:3000` and `http://localhost:3001`.
- `COOKIE_SECURE=true` is required when `NODE_ENV=production`. Cookie SameSite defaults to `lax` and remains configurable under the existing validation. The cookie and CSRF mechanisms were not weakened.
- The CSRF guard still checks the request `Origin` against `CORS_ORIGINS` for cookie-authenticated mutations and compares CSRF cookie/header values with a timing-safe comparison. CORS is not authorization; the existing JWT/role guards remain responsible for access control.
- Both clients retain `credentials: "include"`, CSRF token handling, refresh/retry behavior, and existing response/error handling.
- Health routes remain `/api/v1/health/live` and `/api/v1/health/ready`. Readiness executes a database query; neither endpoint exposes credentials.
- Backend logger redaction for cookies, authorization, CSRF headers, and Set-Cookie headers remains in place.

## Backend variables

Names only are listed here; no real environment values were read or copied.

- Required by existing startup validation: `NODE_ENV`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, `ML_SERVICE_TOKEN`, and `CORS_ORIGINS` (NODE_ENV has a development default; production must explicitly be `production`).
- Production-only requirements from validation: `COOKIE_SECURE=true` and `ML_SERVICE_URL` (valid URI). `ML_SERVICE_URL` currently has no consumer in backend source code; its required production value and private network destination must be decided before deployment.
- `PORT` is optional and defaults to `4000`; set it to the runtime-assigned port when required by the chosen host.
- Existing optional/defaulted settings include `JWT_ACCESS_TTL`, `REFRESH_TOKEN_TTL_DAYS`, `COOKIE_SAME_SITE`, `STUDENT_PREDICTIONS_ENABLED`, `EMAIL_POLICY_APPROVED`, and `SMTP_*`. No prediction generation, automated alerts, or SMTP behavior was enabled.
- `ai-prediction-backend/.env.example` remains a development template, not a production secrets template. It includes placeholders and localhost values for local-only database/API/ML development.

## Local URL audit and classifications

The search excluded `.env` files, dependencies, generated output, and caches. No hardcoded production-facing localhost API request remains in frontend source.

| File and line | Classification |
|---|---|
| `ai-prediction/.env.example:2` | Local development API base URL; documented; keep. |
| `ai-prediction/README.md:22,24` | Local backend/frontend examples; keep and documented. |
| `ai-prediction/lib/api-url.ts:15` | Production guard strings for localhost/loopback; not a destination. |
| `ai-prediction-admin/.env.example:2` | Local development API base URL; documented; keep. |
| `ai-prediction-admin/README.md:7` | Local backend example; documented; keep. |
| `ai-prediction-admin/lib/api-url.ts:15` | Production guard strings for localhost/loopback; not a destination. |
| `ai-prediction-backend/.env.example:3,9,10` | Development-only `DATABASE_URL`, CORS origins, and ML URL examples; placeholders, not production destinations. |
| `ai-prediction-backend/README.md:25,29` | Local development CORS/API and health examples; retained and labeled local. |
| `ai-prediction-backend/src/app.module.ts:45` | Local-only `ML_SERVICE_URL` default; production validation requires an explicit URI. The URL has no current backend consumer. |
| `ai-prediction-backend/src/app.module.spec.ts:14,16` | Test fixture database and CORS localhost values; retain for tests. |
| `ai-prediction-ml/README.md:3,15` | ML service deliberately binds to loopback for local private use; retain. Backend ML network configuration is unresolved, and no public ML endpoint was introduced. |

There were no additional hardcoded local IP URLs in production frontend request code. The backend currently has no ML client/service call sites, even though the configuration variable exists.

## Checks run

Commands were run using the existing installed dependencies; no packages were installed or upgraded.

- Main: `npm.cmd run lint` — passed with one existing `<img>` optimization warning at `components/ui/avatar.tsx:27`; `npm.cmd run typecheck` — passed; `npm.cmd run build` — passed.
- Admin: `npm.cmd run lint` — passed; `npm.cmd run typecheck` — passed; `npm.cmd run build` — passed.
- Backend: `npm.cmd run lint` — passed; `npm.cmd run typecheck` — passed; `npm.cmd test -- --runInBand` — passed, 9 suites / 62 tests; `npm.cmd run build` — passed.
- Prisma schema validation: `npx.cmd prisma validate` — run locally only; no database connection, migration, seed, or database write was performed.
- Static local URL search: remaining matches are classified above; no production-facing frontend localhost dependency remains.

## Remaining blockers before deployment

- Select and verify the production backend host/runtime, networking, TLS/proxy behavior, and `PORT`; no AWS resources or infrastructure were inspected or created.
- Provide production values securely for `DATABASE_URL`, `JWT_ACCESS_SECRET`, `ML_SERVICE_TOKEN`, `ML_SERVICE_URL`, `CORS_ORIGINS`, `COOKIE_SECURE`, and `NODE_ENV`. `ML_SERVICE_URL` needs an internal/private destination if used; the current backend does not consume it.
- Review the existing backend readiness database dependency, Prisma deployment/migration plan, backups, and operational access separately. No database was contacted or modified here.
- Configure the two existing Vercel projects as described in the companion guide and redeploy them only when ready. No Vercel dashboard settings were changed.
- Deploy and verify the API, DNS/TLS, frontend login/session/CSRF behavior, cookie attributes across subdomains, readiness, and CORS in the actual production environment. Production has not been claimed live.
- Prediction generation remains disabled pending the existing model/policy approval; automated alerts and SMTP remain disabled.

## Scope confirmation

No database was connected to, migrated, seeded, reset, or modified. Prisma validation loaded dotenv configuration automatically, but no environment values were printed or inspected manually. No DNS, AWS, or Vercel settings were changed. Nothing was deployed. No secret-bearing `.env` values are included in this report.
