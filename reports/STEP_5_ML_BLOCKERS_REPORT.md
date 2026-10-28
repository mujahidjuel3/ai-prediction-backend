# Step 5 — ML Readiness Blockers Report

**Date:** 2026-10-28  
**Decision:** First gate failed. Stop before dataset validation, training, artifact creation, inference integration, or prediction enablement.

## Executive summary

The project owner has not supplied the prerequisites required to define a valid prediction task. In particular, there is no documented authorized university dataset/provenance, no approved target label, no prediction cutoff/horizon, no feature-availability contract, no approved risk policy/intended use, and no release acceptance criteria.

`DOMAIN_DECISIONS.md` explicitly says there is no default target, calls out multiple distinct possible outcomes, and defers target definition, cutoff/lead time, thresholds, ownership, and review cadence to the university. `ai-prediction-ml/README.md` says no university data, trained model, training metric, or model artifact is included and directs the owner to obtain approval and define the target before training. The only matching CSV file found in the workspace is `ai-prediction-backend/docs/academic-records-template.csv`, a schema/import template rather than an authorized training dataset.

No dataset contents were opened, no records were printed, no training or prediction was run, no model artifact was generated, and no backend/frontend prediction behavior was enabled or changed. As instructed, work stops at this blockers report.

## First-gate checklist

| Required input | Current evidence | Status |
|---|---|---|
| Authorized dataset and provenance | No dataset file is present in `ai-prediction-ml/data/`; ML README states no university data is included. `DOMAIN_DECISIONS.md` requires an approved local CSV and still defers data owner, permitted columns, lawful basis, retention and de-identification. The backend CSV is a template only. | **Missing — blocking** |
| Precise prediction target and label definition | `DOMAIN_DECISIONS.md` states “No default target” and lists distinct possibilities such as course failure, low GPA, or dropout. No target has been chosen or formally labeled. | **Missing — blocking** |
| Prediction cutoff and horizon | No institutional decision is recorded. ML README requires a cutoff and lead time in the target definition but provides only a synthetic example. | **Missing — blocking** |
| Feature availability at prediction time | No approved feature list, source, timestamp semantics, or evidence that each value exists before the cutoff. README describes exclusions but only as guidance, not a dataset contract. | **Missing — blocking** |
| Documented risk policy/threshold and approved intended use | `DOMAIN_DECISIONS.md` explicitly defers thresholds, policy owner/effective date/review cadence and student visibility. No intended-use or human-review approval is provided. | **Missing — blocking** |
| Evaluation and release acceptance criteria | No approved minimum metrics, calibration criteria, subgroup/fairness review, sample-size policy, monitoring, rollback, or release owner is recorded. | **Missing — blocking** |

## Existing ML/backend state (source inspection only)

- `ai-prediction-ml/app/main.py` is a FastAPI service with `/health/live`, `/health/ready`, token-protected `GET /v1/model` and `POST /v1/predict`. It returns `MODEL_REQUIRED` if local model/metadata files are absent and rejects feature-key mismatch. It has no included model or approved data. No model file was opened or produced.
- `ai-prediction-ml/train.py` is a reproducible training skeleton. It requires an explicit binary target, target definition, feature columns and positive label; optionally supports student-group or temporal holdout. It compares a prior baseline, Logistic Regression and Random Forest, writes a joblib artifact and metadata, and computes classification, PR-AUC, ROC-AUC and Brier metrics. This does not make its example features, binary target, or selection policy institutionally approved.
- `ai-prediction-ml/tests/test_training.py` uses a synthetic fixture. Such tests can establish code behavior only and provide no evidence of student-data model validity or performance. Python tests were not run because the gate prohibits training or evaluation without approved inputs and no need exists to run unrelated synthetic training checks for this blocker decision.
- Backend `src/app.module.ts` has server-side `ML_SERVICE_URL` and `ML_SERVICE_TOKEN` configuration keys, but configuration alone is not an integration. `src/workflows/workflows.controller.ts` implements `POST /predictions/generate` as an unconditional 503 `ServiceUnavailableException` explaining that there is no approved trained model/risk policy. No NestJS-to-FastAPI inference request is present in the reviewed route.
- `prisma/schema.prisma` contains `ModelVersion`, `Prediction` and `PredictionReview` persistence models. Their presence does not establish that any model version or prediction exists in the database; no database query was performed.
- The Step 3 report says the frontend displays stored prediction history only and generation is unavailable. The Step 4 report likewise records that generation is unavailable and no ML service integration was added.

## Exact owner decisions needed

Before any training run, the project owner and the university data/policy authority need to supply or approve all of the following:

1. **Dataset authorization and provenance:** the responsible data owner, permitted purpose, lawful/ethics approval as applicable, source system, extraction date, cohort/time coverage, inclusion/exclusion criteria, retention/deletion policy, permitted columns, and de-identification/pseudonymization method. Provide the approved dataset locally in the ignored `ai-prediction-ml/data/` directory; do not commit or externally upload student records.
2. **One target only:** exact outcome and label-generation rule, observation unit (student-term, student-course-term, or another defined unit), positive/negative labels, treatment of withdrawals/incompletes/missing outcomes, and the outcome window. Course failure, low GPA, and dropout are different targets and cannot be combined by assumption.
3. **Time contract:** exact feature cutoff timestamp/week, prediction horizon/lead time, target observation end, and the time zone/term calendar rules. Clarify whether repeated records exist for each student and how future cohorts will be held out.
4. **Feature contract:** each approved field’s source, type, allowed values, missing-value meaning, timestamp/availability guarantee at cutoff, and transformation rule. Explicitly exclude identifiers and any post-cutoff/outcome/intervention-derived leakage. If group/time splitting is required, provide a pseudonymous grouping field and trustworthy chronological field separately from model features.
5. **Risk and intended-use policy:** whether output is a probability or a category, approved threshold(s), policy owner, effective/review dates, human review/appeal requirements, permitted interventions, prohibited uses (including high-impact automated decisions), recipient scope, and student/teacher visibility. The code must not choose these thresholds.
6. **Release acceptance:** minimum cohort and class counts; required baseline comparison; acceptable PR-AUC/recall/precision and calibration criteria tied to the real intervention costs; subgroup fairness analyses and minimum cohort rules; independent review/sign-off; monitoring, drift/retraining, rollback, audit and model expiry requirements.

## Expected dataset schema to approve

No final column names or data types can be prescribed until the target and source are approved. The minimum logical schema should be agreed before delivery:

| Logical field | Requirement |
|---|---|
| Observation key | A documented stable key for the defined prediction unit; uniqueness rules must be explicit. Do not use a real student identifier as a model feature. |
| Group key (if repeated student rows) | Pseudonymous student/group identifier used only for group-aware splitting and leakage checks, not as a predictor. |
| Time key (when chronology exists) | Reliable term/date/index sufficient for a later-time holdout and cutoff/horizon checks; not a predictor unless explicitly justified and approved. |
| Target label | One approved label column with exact binary or other formally supported class definition, allowed labels, outcome window and missing-label handling. The current trainer supports binary classification only. |
| Approved features | Only fields known at the approved cutoff, with owner/source, types, allowed ranges/categories and missingness semantics documented. |
| Provenance/quality manifest | Separate non-student-record manifest stating source, approval reference, extract date, schema version, cohort coverage, row/column counts, de-identification method and file checksum. |

The current training CLI can accept a CSV plus explicit `--target`, `--target-definition`, `--features`, `--positive-label`, and optional `--student-column`, `--time-column`, `--unique-key`. Its CLI shape is not a substitute for the signed schema/policy decisions above.

## Safe next phase after blockers are resolved

1. Confirm the decisions above and place only the authorized dataset locally; document provenance without recording personal rows in reports or logs.
2. Inspect schema, types, missingness, duplicates, label balance, temporal coverage and leakage risks using aggregate counts only; stop if the data does not satisfy the approved design.
3. Agree on time/group-aware split and minimum evaluation sample sizes before looking at final holdout metrics.
4. Train baseline and candidate models reproducibly, report actual cohort/subgroup metrics and calibration limitations, and obtain independent release approval.
5. Only after model, policy and release criteria are approved, implement authenticated backend-to-ML calls, strict feature DTO validation, safe failure behavior, model-version/prediction persistence, audit/idempotency and tests. Keep generation disabled until those controls pass.

## Scope and verification boundary

- Read previous Step 1–4 reports where present and `DOMAIN_DECISIONS.md`; the original `ACADEMIC_SENTINEL_AUDIT_REPORT.md` is not present at the workspace root.
- Inspected ML source/docs/tests, backend prediction route/configuration, Prisma prediction models, and workspace dataset/artifact filenames. Dataset contents and secret values were not printed.
- No source files, environment files, database records, migrations, model artifacts or training reports were modified or generated. No training, inference, Python tests, backend tests, live API/database check, browser run, package install or deployment was performed.

**Outcome:** ML training and inference integration remain blocked on owner/university decisions and authorized data. Prediction generation remains disabled by the existing backend behavior.
