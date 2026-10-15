# GradeFlow delivery backlog

Statuses describe current evidence. **Partial** means the feature path is implemented but a requested integration, proof or production dependency remains; only mark an outcome complete when its delivered behavior has evidence.

## 1. Workspace design, navigation and interaction — **Partial**

- [x] Inspect and adapt the supplied HTML direction; retain the compact navy sidebar, restrained blue action accent, neutral cards/tables, dashboard and paper-review workspace rather than replacing them with a generic dashboard. Build responsive accessible React/TypeScript pages for account actions, dashboard, batches/exams, review, students, results, marking scheme and settings. **Evidence:** strict TypeScript check, React tests and production frontend build pass.
- [x] Make the implemented navigation and major forms/workflows call the real API; display genuine empty/loading/error states and real school-scoped metrics. Do not seed mock pupils, assessment counts, marks or results to imply completed product use. Provide keyboard-visible focus, form labels, small-screen layouts, status chips and review evidence.
- [ ] Validate the assembled application in a browser on a fully configured hosted service and walk through all important user workflows; only the frontend build and isolated API/form journeys have been run here.
- [x] Publish a root-level `public/manus-routes.json` declaring actual frontend page paths (not APIs, asset paths or invented IDs) and configure Preview/production to serve it as JSON.

## 2. Accounts, school onboarding, organizations and staff — **Partial**

- [x] Implement school registration/setup, email/password sign-in, email verification, password-recovery/reset, account profile, logout, password change, session view/revocation and secure session rotation. Use Argon2id password hashes and opaque one-time tokens/session tokens whose server-side stored values are hashes; expire and revoke sessions/tokens server-side.
- [x] Implement roles Owner, School administrator, Exam officer, Teacher/marker, Reviewer and Viewer; school invitations, staff roles and active/inactive membership controls; users may switch only among active school organizations they belong to. A membership disabled in one school must not disable a different authorized organization membership.
- [x] Enforce active and verified status, organization scoping and role authorization on the API, not only in UI visibility. A user from one school must not retrieve another school's pupils, exams, scans, marks, results, reports, staff or audit records.
- [x] Add hashed-account rate limits, secure cookies, CSRF validation for cookie-authenticated mutations, configurable allowed-origin CORS, safe request IDs and logs without query secrets, request bodies, scanned text, answer content or credentials. Public HTTPS Preview uses `SameSite=None; Secure`; plain-HTTP local development handles its cookie mode separately.
- [ ] Exercise real SMTP delivery and HTTPS iframe login with an operator-configured mail service and browser. When SMTP is unset, only the explicitly marked **development** response returns an action link; production refuses to report an email was sent. Embedded-preview third-party-cookie policies can still block sessions.

## 3. School settings and academic setup — **Partial**

- [x] Provide school profile/settings, staff directory/invitations and role/membership controls; manage academic years, terms, classes and subjects. Validate that year/term/class/subject/enrollment relationships belong to the active organization. Preserve pupil enrollment history.
- [ ] Verify competing school-administrator updates and these records against a dedicated isolated PostgreSQL test service; runtime integration checks to date use only a local SQLite test database.

## 4. Student records and CSV intake — **Partial**

- [x] Provide an organization-scoped, searchable/filterable/paginated student directory; create/update student; student profile; active class/year enrollment and enrollment-history views; expose relevant examination/results history where available.
- [x] Import pupil CSV with persistent import history, field/reference validation and row-specific errors; invalid rows must not be silently represented as successful imports.
- [ ] Exercise large imports, Unicode and malformed-file cases, savepoint/transaction rollback and school-scale pagination with representative administrator-approved data.

## 5. Examinations and versioned rubrics — **Partial**

- [x] Create/list/view/edit examinations; choose their class, subject, academic year and term; set examination type, dates where provided and maximum marks; operate allowed examination status transitions; show details and progress based on persisted script/job/result records.
- [x] Define rubric question/subpart numbers and prompts, expected answers, acceptable alternatives, criteria/partial-credit guidance and per-question maximum marks. Validate the rubric maximum total against exam maximum and lock/version rubric definitions when grading has begun.
- [ ] Verify all date/status transition rules, marks precision and concurrency/older-rubric behavior on PostgreSQL and with larger real sets of scripts.

## 6. Scan upload, privacy, batches and page organization — **Partial**

- [x] Accept authorized PDF and supported PNG/JPEG/TIFF/WebP single/multiple scan uploads with size, extension, MIME and file-signature checks; use server-generated storage keys; show upload progress, validation/deduplication warnings, outcome/error details and persistent batch status. Offer phone-camera capture when the browser/device supports the file-picker capture hint.
- [x] Keep scan originals/pages private and fetchable only through authenticated organization-scoped endpoints; do not publish scan URLs. Support authenticated previews with `no-store`, scripts/pages, manual student assignment/correction, whole-page order, rotation and flags, and preserve source-paper/source-page and rendered-page provenance.
- [x] For mixed-student scans, permit teachers to explicitly select and group ordered source pages into actual per-student scripts. Never infer student identity solely from handwriting similarity; validate selected pages and active exam enrollment before assigning a student.
- [ ] Verify storage lifecycle and durable delivery on the production-like private S3-compatible provider; no S3 credentials or production bucket were provided, so Preview uses a private local adapter that is not durable across deployed-container replacement.

## 7. Queue, vision extraction and AI grading proposals — **Partial**

- [x] Use Celery and Redis for long-running script work; persist job identity/type/state/progress/error/timestamps/attempts and idempotency independently in the relational database; expose tenant-scoped paginated status and valid task-specific retry handling. Failure must be visible and bounded, not silently left as a fake success.
- [x] Make an OpenAI-compatible vision provider's server-side endpoint/model/API key configurable. Send the teacher-organized and oriented script, return structured validated answer/question associations and source-page/region provenance where available, and retain confidence, uncertainty and provider warnings. Bound any score proposal to the applicable rubric maximum and retain evidence/rationale; malformed output/provider errors fail clearly rather than inventing data.
- [x] Let authorized teachers inspect/edit extraction text and question association, mark unclear pages, and explicitly confirm extraction before grading. Save teacher corrections/confirmation as auditable actions.
- [ ] Test a real external model call, private scan transfer, queue crash recovery, timeouts/provider throttling, malformed payload and max-retry/failure behavior with the configured provider/Redis/PostgreSQL. No vision-provider or production Redis credentials were supplied, and unit/API checks use no real model call.

## 8. Mark review, server totals, results and reporting — **Partial**

- [x] Present a teacher review workflow with private source pages, script/student/exam association, extracted answers and rubric criteria, evidence/rationale, confidence/uncertainty/warnings and provisional AI marks. AI-generated marks are never final without explicit teacher approval.
- [x] Permit an authorized teacher to confirm each rubric-item score; reject negative values and marks above that item's maximum. Store confirmer/time, require a correction reason when changing a confirmed mark, calculate totals on the server after all items for that script are confirmed, and move a formerly published total back to finalized/draft-for-republication after a correction.
- [x] Display organization-scoped finalized/published results, role-gate publication controls, record mark/publication changes in audit history, and provide protected CSV and XLSX exports with spreadsheet-formula-safe user strings.
- [ ] Complete class/subject breakdown analytics and broader multi-question/multi-script result regressions before a school-wide rollout.

## 9. Tenant data/API/migration foundation — **Partial**

- [x] Provide `/api/v1` FastAPI endpoints and validated Pydantic inputs/responses for accounts/sessions, organizations/staff/invitations, academic years/terms/classes/subjects, students/enrollments/import history, exams/rubrics, papers/private files/pages/upload batches, processing/extraction/grading, teacher-confirmed marks/results/publication/exports and audit history.
- [x] Use SQLAlchemy 2, UUIDs, timestamps, organization FKs/indexes/unique constraints and explicit delete behavior across users, organizations/memberships/invitations, auth sessions/action tokens, years/terms/classes/subjects, students/enrollments/imports, exams/rubrics/items, papers/files/pages/batches, jobs/extractions/grading runs/grades, exam results and audit events. Use paginated/validated API boundaries rather than directly exposing ORM rows.
- [x] Generate a repeatable initial Alembic schema revision and run a local SQLite migration smoke test; add health and database-readiness, versioned docs and safe validation/auth response handling. Tests target isolated file-backed SQLite/private storage; never use the shared managed database for tests.
- [ ] Apply and validate the revision on the **requested PostgreSQL** version and verify FK/index/transaction/concurrency behavior there. The WebDev-managed database enabled at initialization is MySQL and is deliberately not being used as a silent PostgreSQL substitute; no external PostgreSQL service was supplied.

## 10. Runtime security, deployment, privacy and recovery — **Partial**

- [x] Ship pinned frontend/backend dependencies; `.env.example`; Dockerfile; Compose profile for React/Vite, FastAPI, PostgreSQL, authenticated Redis, migration, Celery worker and local-only scan volume; and a same-origin production static/API container honoring `PORT` with unauthenticated `/ready` health response.
- [x] Keep SMTP, Postgres, model and object-storage credentials server-side; require production configuration; disable production schema autogeneration and fail closed instead of falling back to SQLite/local ephemeral scan storage. Keep uploaded files private, validate inputs, use DB transactions and run shared production rate limits through Redis.
- [x] Document school-staff least privilege, education-record/scan/AI-provider privacy, credential protection, retention ownership, secure backup and isolated restore guidance for Nigerian schools. Clearly state that this is not school-specific legal advice and that real AI service terms/locations/retention need institutional review.
- [ ] Configure and rehearse an administrator-approved school retention/purge process, scan-object deletion and production backup/restore. The application does not yet implement an automated per-school retention timer or an object-purge console; no durable S3/PostgreSQL/mail/provider account was configured for live rehearsal.
- [ ] Run the Docker/Compose build/start/migration/health workflow in an environment with Docker; Docker is unavailable here, so Compose configuration has not been executed.

## 11. Automated delivery evidence and handoff — **Partial**

- [x] Pass strict TypeScript checking, React/Vitest sign-in/form validation tests, and a production Vite build. **Current evidence:** `pnpm typecheck`, `pnpm test`, and `pnpm build` passed.
- [x] Pass source compilation/import and an isolated API/security/tenant/assessment integration suite covering verification/reset, session rotation/revocation, school isolation, rubric total validation, private scan previews, extraction corrections/confirmation, score maximum and correction reason, server total, publication/republication audit, and CSV/XLSX formula escaping. **Current evidence:** `PYTHONPATH=backend .venv/bin/pytest -q` reports 7 passed. Initial migration revision generated and applied successfully to a separate local SQLite smoke file. Upstream Starlette/AnyIO/PyMuPDF deprecation notices remain.
- [ ] Rerun relevant checks after final packaging changes; verify running-origin `/ready` and `/manus-routes.json`; confirm a read-only review identifies no remaining in-scope cross-module implementation gap.
- [ ] Before recording any project checkpoint, set root `app.config.ts` with a durable HTTPS `logoUrl` literal for the uploaded GradeFlow brand mark; site favicons do not populate project-logo metadata.
- [ ] Final handoff must identify source structure and routes, core API/model/migration coverage, run/build/test commands, necessary external settings, any unverified or unfinished features and deployment steps. Do not claim Docker, PostgreSQL, external integrations, backup rehearsal or successful publication unless actually confirmed.
