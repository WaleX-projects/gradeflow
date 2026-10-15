# GradeFlow

GradeFlow is an AI-assisted examination scanning and grading workspace for Nigerian schools. It uses real school records in the interface; it does not seed sample pupils, exams, marks or dashboard metrics. Proposed AI marks are **not final** until a teacher has confirmed each rubric item.

## Architecture and environment constraints

- **Frontend:** React 19, TypeScript, Vite 7, React Router 7, TanStack Query, React Hook Form/Zod, Tailwind CSS and Lucide. A typed same-origin `/api/v1` client uses cookie credentials and sends the CSRF header on protected writes. Vite proxies the API in Preview and Compose development.
- **Backend:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2 and Alembic in a modular monolith. Passwords use Argon2id; opaque session credentials are stored as hashes, revocable and rotated. Organization membership and role checks are enforced server-side. Request logs omit query strings, bodies, scan text and credentials.
- **Database:** the target is PostgreSQL. The WebDev-managed database supplied at project initialization is **MySQL**, so GradeFlow deliberately does not use its `DATABASE_URL`; the managed capability cannot be switched back off. The current Preview and automated API tests use isolated file-backed SQLite. SQLite is only a development/test adapter, not a production fallback. Set `GRADEFLOW_DATABASE_URL` to an isolated/production PostgreSQL service and apply reviewed Alembic migrations.
- **Processing:** API and Celery worker share Redis and PostgreSQL. Processing-job status, progress, failures and attempt counts are persistent. Provider/worker absence results in a truthful unavailable/failure state, never a fake score.
- **Scans:** private local file storage is for development only. Production uses private S3-compatible object storage; every file/page fetch is authenticated, organization-scoped and no-store. No public scan URL is exposed.
- **AI:** an OpenAI-compatible vision endpoint/model/key are configurable in the server environment. Structured transcription includes source page/region, confidence and uncertainty. Rubric-bound grading proposals retain evidence/rationale and are checked against maximum marks before a teacher reviews them.

Email/password registration was explicitly requested. In non-production development only, if SMTP is unset, the API returns a one-time verification/reset/invitation link rather than claiming to have sent mail. Production requires configured SMTP and never exposes those local action links.

## Pages and API

The frontend routes cover account creation/sign-in, email verification, password recovery, invitation acceptance, dashboard, exams/batches, scan organization, marking review, pupils, marking scheme, results and school settings. Settings include profile/school changes, workspace switching, sessions, staff/invitations, academics, and an audit timeline for authorized roles.

The API is under `/api/v1`. It includes authentication/sessions/profile/workspaces; staff and invitations; years/terms/classes/subjects; students/enrollments/history/CSV import; exams/rubrics; secure single/bulk PDF/image intake, upload-batch history, page previews/order/rotation/flags and manual script grouping; persistent processing/retries; extraction correction/confirmation; score-limited teacher confirmation; results, publication and CSV/XLSX exports; and audit activity. FastAPI documentation is at `/api/v1/docs`.

Every school-data query is scoped to an active, authorized membership. UI visibility is convenience only; the backend enforces role permissions. CSV/XLSX text values that could be interpreted as formulas are escaped.

## WebDev Preview in this sandbox

Project root: `/home/ubuntu/gradeflow`. Vite listens on **3000**; FastAPI listens on **8000** and Vite proxies `/api/v1`, `/health` and `/ready` to it. Current local/Preview data is stored in `data/gradeflow.db`; uploads are under the ignored private `storage/` directory.

```sh
cd /home/ubuntu/gradeflow
mkdir -p data storage/private
PYTHONPATH=backend \
  GRADEFLOW_DATABASE_URL=sqlite:///./data/gradeflow.db \
  GRADEFLOW_ENVIRONMENT=development \
  GRADEFLOW_COOKIE_SECURE=true \
  GRADEFLOW_AUTO_CREATE_SCHEMA=true \
  .venv/bin/uvicorn app.main:app --app-dir backend \
    --host 0.0.0.0 --port 8000
```

In a separate terminal:

```sh
cd /home/ubuntu/gradeflow
pnpm dev -- --host 0.0.0.0 --port 3000
```

Public HTTPS Preview uses `SameSite=None; Secure` cookies, even though its reverse proxy may contact the development server over HTTP. For a plain-HTTP local browser only, set `GRADEFLOW_COOKIE_SECURE=false`. Browser third-party-cookie restrictions can still affect an embedded Preview login.

## Local Docker Compose development

Docker is **not installed in the current sandbox**, so the Compose stack below could not be run here. On a Docker Engine host with the Compose plugin:

1. Copy `.env.example` to `.env`. Replace the local-only `GRADEFLOW_SESSION_PEPPER`, PostgreSQL password and Redis password with unique development values. Keep the sample localhost-only port bindings. Make `GRADEFLOW_COMPOSE_DATABASE_URL`, `GRADEFLOW_RATE_LIMIT_URL` and the Celery Redis URLs match those credentials; URL-encode reserved characters in DSN credentials.
2. Run `docker compose up --build`.
3. Open `http://localhost:3000`; API docs are at `http://localhost:8000/api/v1/docs`.

Compose starts a pinned PostgreSQL service, authenticated Redis, one-time migration service, FastAPI API, Celery worker and Vite frontend. Named local volumes retain database/Redis state and development uploads. Example secrets in `.env.example` are **not production values**. Do not expose this development profile publicly. If switching to real SMTP, object storage or a model provider for testing, do not submit real pupil scans until the school has approved those services.

## Dependencies, migrations and tests

Frontend dependencies are pinned by `pnpm-lock.yaml` and `packageManager: pnpm@11.25.0`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Production Python dependencies are pinned in `backend/requirements.txt`; test and formatting tools are pinned separately in `backend/requirements-dev.txt`:

```sh
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
PYTHONPATH=backend .venv/bin/pytest
```

Pytest configures its own `data/gradeflow_pytest.db` and `storage/pytest-private` paths before importing the app. It does not use WebDev's shared database or the Preview database. Use a separate disposable PostgreSQL test instance for PostgreSQL integration testing—never run test cleanup or destructive fixtures against production or the managed WebDev database.

Use PostgreSQL for migrations/deployment; the checked-in migration can also be smoke-tested on the isolated local SQLite file:

```sh
PYTHONPATH=backend .venv/bin/alembic -c backend/alembic.ini upgrade head
PYTHONPATH=backend .venv/bin/alembic -c backend/alembic.ini current
```

Generate migrations from model changes, review the generated DDL, and apply them as a separate deployment step:

```sh
PYTHONPATH=backend .venv/bin/alembic -c backend/alembic.ini revision --autogenerate -m "describe the schema change"
PYTHONPATH=backend .venv/bin/alembic -c backend/alembic.ini upgrade head
```

`GRADEFLOW_AUTO_CREATE_SCHEMA=true` is a development convenience only; production rejects it. The container honors `PORT`, defaults to port **3000** on `0.0.0.0`, serves the compiled SPA from `/static`, and provides an unauthenticated `/ready` route that checks database readiness. `public/manus-routes.json` declares only frontend routes and is copied to the production web root.

## Required server configuration for production

Keep actual values in protected server runtime configuration, never in Git, the browser bundle, query strings or chat:

| Variable | Production setting |
| --- | --- |
| `GRADEFLOW_ENVIRONMENT` | `production`; activates configuration guardrails. |
| `GRADEFLOW_DATABASE_URL` | TLS-protected PostgreSQL DSN, preferably `postgresql+psycopg://…`. |
| `GRADEFLOW_SESSION_PEPPER` | Unique high-entropy secret (at least 32 characters). |
| `GRADEFLOW_COOKIE_SECURE` | `true`; HTTPS uses the embedded-Preview-compatible `SameSite=None; Secure` cookie attributes. |
| `GRADEFLOW_AUTO_CREATE_SCHEMA` | `false`; run committed Alembic migrations. |
| `GRADEFLOW_RATE_LIMIT_URL` | Shared `redis://` or `rediss://` connection. In-process throttling exists only as a bounded non-production fallback. |
| `GRADEFLOW_CELERY_BROKER_URL`, `GRADEFLOW_CELERY_RESULT_BACKEND` | Redis-backed Celery configuration. |
| `GRADEFLOW_STORAGE_BACKEND` | `s3`; production fails startup rather than treating ephemeral local disk as durable. |
| `GRADEFLOW_S3_BUCKET`, `GRADEFLOW_S3_ACCESS_KEY`, `GRADEFLOW_S3_SECRET_KEY` | Credentials for a private, narrowly scoped S3-compatible bucket. |
| `GRADEFLOW_S3_ENDPOINT_URL`, `GRADEFLOW_S3_REGION`, `GRADEFLOW_S3_SERVER_SIDE_ENCRYPTION` | Configure the actual provider endpoint/region and encryption controls. Deny public access and require TLS. |
| `GRADEFLOW_SMTP_HOST`, `GRADEFLOW_SMTP_PORT`, `GRADEFLOW_EMAIL_FROM`, `GRADEFLOW_FRONTEND_ORIGIN` | Production requires email delivery and a fixed frontend origin for real verification/recovery links. |
| `GRADEFLOW_SMTP_USER`, `GRADEFLOW_SMTP_PASSWORD` | Set via protected server configuration when the mail provider requires authentication. |
| `GRADEFLOW_VISION_BASE_URL`, `GRADEFLOW_VISION_MODEL`, `GRADEFLOW_VISION_API_KEY` | Optional OpenAI-compatible provider; credentials stay server-side. Jobs fail clearly when it is not configured. |
| `GRADEFLOW_MAX_UPLOAD_BYTES`, `GRADEFLOW_STORAGE_DIR` | Upload bound and development private-storage path. Local files are not production-durable. |

The project is a monolith, not Kubernetes/microservices. Use TLS, least-privilege accounts, managed database/object backups, safe proxy-header configuration, operational health monitoring and documented incident-response access. No SMTP, external PostgreSQL or private S3 credentials were supplied for this task, so live delivery and durable production scans still require operator setup and a service test.

## Privacy, retention and recovery

Scans, pupil identifiers and answers may be sensitive education records. Grant staff only the minimum role needed, review memberships/invitations periodically, keep object storage private and encrypted, use TLS, and do not use production pupil scans as ordinary development fixtures. Before sending scans/answers to an AI service, the school must review provider terms, data location, retention and permitted-processing basis. Access logs omit request query strings, body content and credentials; the audit feed intentionally does not show answer text.

Set a school-approved retention schedule with the school administrator/data-protection lead. GradeFlow currently has no automated per-school retention timer or end-user scan purge console. Hiding/removing a database record does not by itself prove its private object has been physically erased; coordinate authorized logical handling, object deletion and any legally required audit retention. The runtime object-storage API has no listing/purge endpoint. Consult appropriate Nigerian privacy counsel/current data-protection guidance for school-specific obligations; this README is not legal advice.

Back up PostgreSQL and private object storage through their configured providers, restrict and encrypt backup access, retain backups under the approved schedule, and regularly rehearse restore in an **isolated** recovery target. Example PostgreSQL backup command (only run on a database you administer and intend to back up):

```sh
pg_dump --format=custom --no-owner --no-privileges "$GRADEFLOW_DATABASE_URL" \
  --file "gradeflow-$(date +%F).dump"
```

Enable private-bucket versioning/provider backups and keep object keys consistent with database rows. Restore to a separate verified target; review any command that might overwrite data before using it.

## Known unverified/deployment items

The Compose workflow could not be run because Docker is absent from this sandbox. Production PostgreSQL, SMTP, S3 and vision credentials/providers were not supplied, so those external service integrations are configurable but not live-tested here. The managed WebDev database is MySQL and has not been used; the required PostgreSQL target remains an explicitly configured external service. Preview, a SQLite smoke migration, or local results are not evidence of a published or production-ready deployment.
