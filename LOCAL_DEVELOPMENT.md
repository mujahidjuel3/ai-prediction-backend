# Academic Sentinel local development

This workspace contains the main frontend (`ai-prediction`), admin frontend (`ai-prediction-admin`), NestJS API (`ai-prediction-backend`) and private Python service (`ai-prediction-ml`). Source defaults use local ports 3000, 3001, 4000 and 8000. These are development ports, not production settings.

## Current setup state

Workspace inspection found clean Git working trees for both existing frontend repositories, an empty backend directory, and no university dataset. Node/npm are present. Python, PostgreSQL client and Docker were not available through this environment at implementation start. The backend, Prisma schema/migration, ML pipeline, and frontend login/session integration have since been added. Database migration/startup and Python tests remain unverified until those runtimes are installed. No external service or cloud deployment is required.

See `ai-prediction-backend/README.md` for database/API setup and `ai-prediction-ml/README.md` for the dataset schema and training command. `DOMAIN_DECISIONS.md` records policy questions still requiring institutional confirmation.

Run each service in a separate PowerShell terminal:

```powershell
cd D:\Project\academic\ai-prediction-backend
npm.cmd run start:dev
```

```powershell
cd D:\Project\academic\ai-prediction-ml
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

```powershell
cd D:\Project\academic\ai-prediction
npm.cmd run dev -- -p 3000
```

```powershell
cd D:\Project\academic\ai-prediction-admin
npm.cmd run dev -- -p 3001
```

Frontend API origins are documented in each `.env.example`; copy to `.env.local` as `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/api/v1`. Never put secrets in frontend environment variables. The API uses its own uncommitted `.env`; follow the backend README. The ML service requires the same locally generated `ML_SERVICE_TOKEN` in both processes.

Login/session UI now uses the backend API, but the main frontend's dashboard/data layer still uses its demo fixtures and the admin panel's CRUD workflows still use its in-memory store. Those application integrations remain implementation work. Until authorized data is supplied and evaluated, the system has no trained model and must not be described as validated AI. The ML service currently is not wired to prediction persistence in NestJS; prediction generation intentionally responds that a trained model and policy are required.
