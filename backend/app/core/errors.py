import json
import logging
import re
from time import perf_counter
from uuid import uuid4

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

logger = logging.getLogger("gradeflow.access")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_PUBLIC_MUTATIONS = {
    "/api/v1/auth/register",
    "/api/v1/auth/login",
    "/api/v1/auth/verify-email",
    "/api/v1/auth/verify-email/resend",
    "/api/v1/auth/forgot-password",
    "/api/v1/auth/reset-password",
}


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        supplied = request.headers.get("x-request-id", "")
        request_id = supplied if _REQUEST_ID.fullmatch(supplied) else str(uuid4())
        request.state.request_id = request_id
        started = perf_counter()
        try:
            response = await call_next(request)
        except Exception as exc:
            response = JSONResponse(
                status_code=500,
                content={
                    "error": {
                        "code": "internal_error",
                        "message": "The request could not be completed.",
                        "request_id": request_id,
                    }
                },
            )
            # Intentionally log only the exception class, never its message, request body,
            # credentials, scanned content or student answers.
            status_code = 500
            logger.error(
                "%s",
                json.dumps(
                    {
                        "event": "request_failure",
                        "request_id": request_id,
                        "method": request.method,
                        "path": request.url.path,
                        "exception_type": type(exc).__name__,
                    },
                    separators=(",", ":"),
                ),
            )
        else:
            status_code = response.status_code

        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
        if request.url.path.startswith("/api/v1/"):
            response.headers["Cache-Control"] = "private, no-store"
        duration_ms = round((perf_counter() - started) * 1000, 2)
        logger.info(
            "%s",
            json.dumps(
                {
                    "event": "http_request",
                    "request_id": request_id,
                    "method": request.method,
                    "path": request.url.path,
                    "status_code": status_code,
                    "duration_ms": duration_ms,
                },
                separators=(",", ":"),
            ),
        )
        return response


class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        method = request.method.upper()
        path = request.url.path
        if (
            method in {"POST", "PUT", "PATCH", "DELETE"}
            and path.startswith("/api/v1/")
            and path not in _PUBLIC_MUTATIONS
            and request.cookies.get("gradeflow_session")
        ):
            cookie_token = request.cookies.get("gradeflow_csrf")
            header_token = request.headers.get("x-csrf-token")
            if (
                not cookie_token
                or not header_token
                or not secrets_compare(cookie_token, header_token)
            ):
                return JSONResponse(
                    status_code=403,
                    content={
                        "error": {
                            "code": "csrf_failed",
                            "message": "Refresh the page and try the request again.",
                        }
                    },
                )
        return await call_next(request)


def secrets_compare(left: str, right: str) -> bool:
    import hmac

    return hmac.compare_digest(left, right)


def error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"error": {"code": code, "message": message}}
    )
