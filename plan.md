# GradeFlow — Architecture & Implementation Plan

## Source and scope

The supplied `pasted_content.txt` contains the complete product brief and the original GradeFlow HTML/CSS/JavaScript. The original interaction/design direction is a compact navy assessment workspace with restrained blue actions, pale neutral surfaces, concise school tables, status chips, a dashboard and a paper-review workflow. Preserve this identity, improve responsive/accessibility details, and remove all sample-only metrics/answers from the actual product.

This is an implementation of a real modular monolith, not a static mock: React pages call a persistent FastAPI API; authenticated organization records drive the UI; private scan files are authorized server-side; queue/AI states are not fabricated; all marks remain provisional until a teacher confirms each question. Build the requested capabilities incrementally and mark any credential-dependent or incomplete workflows openly in `TODO.md` and the final handoff.

## Architecture

- **Frontend:** React 19, TypeScript, Vite 7, React Router, Tailwind CSS, Lucide icon system, TanStack Query, React Hook Form/Zod. Feature-level pages use a typed `/api/v1` client with same-origin cookies and CSRF header. Vite proxies `/api/v1` to FastAPI during Preview. Production container serves the built SPA and API on one origin.
- **Backend:** Python 3.12, FastAPI, Pydantic 2, SQLAlchemy 2, Alembic and Argon2id, organized as a modular monolith (`core`, `models`, `schemas`, `routers`, `services`, tasks). A separate Celery worker connects through Redis; PostgreSQL persists application/job history.
- **Database constraint:** the WebDev-managed database supplied during initialization is MySQL, whereas this product explicitly requires PostgreSQL. That managed service cannot be reversed and is intentionally not used for GradeFlow. Application and migration code target PostgreSQL through `GRADEFLOW_DATABASE_URL`; the working Preview/tests use file-backed SQLite. SQLite is development-only, not a production substitute. Deploy against configured external PostgreSQL.
- **Identity/tenancy:** self-managed email/password was explicitly requested; Argon2id hashes, one-time email-action tokens, opaque revocable hashed sessions, rotation/revocation, CSRF double-submit validation and role-scoped organization memberships protect the app. SMTP is configurable; a one-time development-only link allows local/Preview registration without pretending an email was sent. All school-owned resource queries must derive an active authorized membership on the server.
- **Files and AI:** the running workspace uses private local storage behind authenticated endpoints, type/size/signature checks and no-store previews. Production needs durable private object storage/S3-compatible persistence shared by API/workers. An OpenAI-compatible provider adapter accepts server-only endpoint, model and API key. Structured transcription/grading outputs are validated and saved with source references/uncertainty; teacher corrections and explicit confirmation gate final grades. Missing credentials/workers produce actual failure/unavailable states.
- **API:** `/api/v1` routers for auth/sessions/profile, organization/staff, academics, students, exams/rubrics, uploads/scripts/pages, processing/extraction/review, grades/results/publication/audit. Use UUIDs, transactions, scoped access, Pydantic requests, explicit API views, errors and paginated records.
- **Operations and tests:** PostgreSQL/Alembic migrations, Docker Compose for frontend/API/Postgres/Redis/Celery, `.env.example`, Pytest/HTTPX and React tests; docs cover migrations, secrets, privacy, backups and local startup. Testing uses an isolated local SQLite DB/provider mock, never the shared managed database.

## Project structure

```text
frontend/src/app/              router, authentication/session state
frontend/src/components/       shared shell, controls, notices, tables
frontend/src/features/         dashboard, academics, students, exams/rubrics,
                                papers/review, results, settings
frontend/src/services/         typed API client
backend/app/main.py             FastAPI, versioned routers, readiness/security
backend/app/core/               configuration, security, authorization, middleware
backend/app/models/             SQLAlchemy tenant/domain entities
backend/app/schemas/            Pydantic API contracts
backend/app/routers/            versioned auth, staff, resource and paper APIs
backend/app/services/           SMTP and configurable vision adapter
backend/app/tasks.py             Celery extraction/grading worker tasks
backend/alembic/                 schema migration history
backend/tests/                   isolated API/security/provider tests
public/manus-routes.json         complete frontend route manifest
Dockerfile, docker-compose.yml, .env.example, README.md, plan.md, TODO.md
```

## Design system

- **Design movement:** editorial school-workspace utility, informed by restrained Swiss/institutional administration interfaces.
- **Core principles:** data legibility; teacher authority over AI; quiet hierarchy; visible evidence/status.
- **Color philosophy:** retain deep ink/navy for institutional trust, one GradeFlow assessment blue for deliberate actions, neutral paper/document surfaces, restrained green/amber/red for verified states and exceptions.
- **Layout paradigm:** persistent narrow workspace rail with a flexible left-aligned data canvas; review uses a script/evidence pane beside decision controls; tables adapt by horizontal scroll on mobile.
- **Signature elements:** a distinctive GradeFlow monogram tile; precise status chips and progress rules; a warm paper surface paired with extracted-answer/evidence detail.
- **Interaction philosophy:** direct navigation, useful field feedback, keyboard-visible focus, reversible edits where practical, explicit confirmation for final marks and publication; never silently auto-approve or auto-identify.
- **Animation:** short and low-amplitude for shell/dialog state only, respect reduced-motion, keep grading content still.
- **Typography:** native system sans stack to avoid sending school-data workspace traffic to external font providers; strong compact headings and clearly differentiated tabular marks/counts.
- **Brand essence:** a dependable assessment workspace helping school staff organize and verify examinations; **clear, measured, accountable**.
- **Brand voice:** precise, calm and teacher-centered. Example: “Review the evidence before confirming.” “No results have been published.”
- **Wordmark & logo:** an ownable square folded-paper/grid monogram around a single G, paired with a compact GradeFlow wordmark.
- **Signature brand color:** GradeFlow assessment blue, inspired by the supplied `#285bc5`.

## Implementation and material constraints

Plan, project backlog and selected implementation guides are recorded before the application code. TypeScript and Python diagnostics are selected for the project (the Python interpreter is `.venv`; code is also verified with executable compile/test checks). No external PostgreSQL, SMTP or vision-provider credential was supplied; external service flows are configurable and must report a real unavailable state until configured. Do not enter secrets into chat/source or use the WebDev managed MySQL as a hidden substitution. No third-party release, purchase, or public broad-audience post is authorized by this task.
