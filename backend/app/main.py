from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.core.errors import RequestIDMiddleware, SecurityMiddleware
from app.core.rate_limit import close_rate_limiter
from app.database import Base, engine
from app import models  # noqa: F401 - register model metadata
from app.routers.auth import router as auth_router
from app.routers.papers import router as papers_router
from app.routers.resources import router as resources_router
from app.routers.staff import router as staff_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.validate_production()
    if settings.auto_create_schema:
        Base.metadata.create_all(bind=engine)
    if settings.storage_backend == "local":
        settings.storage_dir.mkdir(parents=True, exist_ok=True)
    try:
        yield
    finally:
        await close_rate_limiter()


app = FastAPI(
    title="GradeFlow",
    version="0.1.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(SecurityMiddleware)
app.add_middleware(RequestIDMiddleware)
if settings.frontend_origin:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=[
            "Content-Type",
            "Authorization",
            "Idempotency-Key",
            "X-Request-ID",
            "X-CSRF-Token",
        ],
    )


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, _exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "validation_error",
                "message": "Review the submitted fields and try again.",
            }
        },
    )


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        message = detail.get("message", "The request could not be completed")
        payload: dict[str, str] = {
            "code": str(detail.get("code", "request_rejected")),
            "message": str(message),
        }
        if detail.get("paper_id"):
            payload["paper_id"] = str(detail["paper_id"])
    else:
        payload = {"code": "request_rejected", "message": str(detail)}
    return JSONResponse(
        status_code=exc.status_code, content={"error": payload}, headers=exc.headers
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    try:
        with engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")
    except Exception:
        return JSONResponse(
            status_code=503, content={"status": "not_ready", "reason": "database_unavailable"}
        )
    return {"status": "ready"}


api = FastAPI(title="GradeFlow API v1", version="0.1.0", docs_url="/docs", redoc_url=None)
api.include_router(auth_router)
api.include_router(resources_router)
api.include_router(papers_router)
api.include_router(staff_router)
app.mount("/api/v1", api)

# Container publication serves the built SPA from the same origin as the API.
static_root = Path(__file__).resolve().parents[2] / "static"
if static_root.is_dir():
    if (static_root / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=static_root / "assets"), name="assets")

    @app.get("/manus-routes.json", include_in_schema=False)
    def route_manifest():
        manifest = static_root / "manus-routes.json"
        if not manifest.is_file():
            raise HTTPException(404, "Route manifest not found")
        return FileResponse(
            manifest, media_type="application/json", headers={"Cache-Control": "no-store"}
        )

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path.startswith(("api/", "health", "ready", "manus-storage/")):
            raise HTTPException(404, "Not found")
        candidate = (static_root / path).resolve()
        if static_root.resolve() in candidate.parents and candidate.is_file():
            return FileResponse(
                candidate,
                headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
            )
        index = static_root / "index.html"
        return FileResponse(index, headers={"Cache-Control": "no-store"})
