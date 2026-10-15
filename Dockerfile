# ---------- Stage 1: build the frontend ----------
FROM node:22.13.0-bookworm-slim AS frontend-build
WORKDIR /source

# Install pnpm directly from npm (avoids corepack's signature-key failure)
RUN npm install -g pnpm@11.25.0

# Install dependencies first so this layer is cached until the lockfile changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY frontend ./frontend
COPY public ./public
COPY vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json tailwind.config.js postcss.config.js ./
RUN pnpm run build


# ---------- Stage 2: Python application ----------
FROM python:3.12.3-slim AS application

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    GRADEFLOW_ENVIRONMENT=production \
    GRADEFLOW_AUTO_CREATE_SCHEMA=false \
    GRADEFLOW_COOKIE_SECURE=true

WORKDIR /app

COPY backend/requirements.txt /app/backend/requirements.txt
RUN python -m pip install --no-cache-dir --disable-pip-version-check -r /app/backend/requirements.txt

COPY backend/app /app/backend/app
COPY backend/alembic /app/backend/alembic
COPY backend/alembic.ini /app/backend/alembic.ini

COPY --from=frontend-build /source/frontend/dist /app/static
COPY public/manus-routes.json /app/static/manus-routes.json

EXPOSE 3000
CMD ["sh", "-c", "exec uvicorn app.main:app --app-dir /app/backend --host 0.0.0.0 --port ${PORT:-3000} --proxy-headers"]