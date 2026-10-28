# Vercel Production Environment Setup

This guide prepares the existing frontend projects to call the configured API domain. No Vercel settings have been changed and no deployment has been started.

## Value to set in both projects

| Vercel project (verify identity before saving) | Variable | Value | Expected format |
|---|---|---|---|
| `ai-prediction` | `NEXT_PUBLIC_API_BASE_URL` | `https://api.academicsentinel.live/api/v1` | Full API base URL, including `/api/v1`. |
| `ai-prediction-admin` | `NEXT_PUBLIC_API_BASE_URL` | `https://api.academicsentinel.live/api/v1` | Full API base URL, including `/api/v1`. |

The API origin is `https://api.academicsentinel.live`. The configured variable value is the full API base URL, `https://api.academicsentinel.live/api/v1`. The frontend URL helper normalizes the prefix, so it is used exactly once.

## Dashboard steps for each project

1. Open the existing Vercel project you intend to configure.
2. Verify the project’s Git repository, production domain, and application identity. Do not rely on the displayed project name alone; confirm it is the Main frontend for `ai-prediction` or the Admin frontend for `ai-prediction-admin` before saving.
3. Open **Settings → Environment Variables**.
4. Add or update `NEXT_PUBLIC_API_BASE_URL` with the value shown above.
5. Select **Production** as the environment scope. Add Preview or Development scope only if you have intentionally chosen those environments to use the production API.
6. Save the variable, then repeat for the other verified project.

## Redeployment

Next.js exposes `NEXT_PUBLIC_*` values to browser code during the build. A new production deployment/build is required for the new value to take effect. Existing deployments keep the value compiled into them. Coordinate that redeployment only after the backend endpoint is deployed and ready; setting this variable does not deploy or verify the API.

The local `.env.example` in each frontend uses `http://localhost:4000/api/v1` for local development. Do not enter that local value in the Vercel Production scope.
