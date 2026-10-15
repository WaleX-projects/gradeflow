'''
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GRADEFLOW_", extra="ignore")

    environment: str = "development"
    database_url: str = "sqlite:///./data/gradeflow.db"
    session_pepper: SecretStr = SecretStr("development-only-change-before-production")
    cookie_secure: bool = True
    auto_create_schema: bool = True
    storage_backend: Literal["local", "s3"] = "local"
    storage_dir: Path = Path("./storage/private")
    s3_endpoint_url: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str | None = None
    s3_access_key: SecretStr | None = None
    s3_secret_key: SecretStr | None = None
    s3_server_side_encryption: bool = True
    max_upload_bytes: int = 20 * 1024 * 1024
    rate_limit_url: SecretStr | None = None
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"
    vision_base_url: str | None = None
    vision_model: str | None = None
    vision_api_key: SecretStr | None = None
    vision_timeout_seconds: int = 60
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    email_from: str | None = None
    frontend_origin: str | None = None

    @property
    def vision_ready(self) -> bool:
        return bool(self.vision_base_url and self.vision_model and self.vision_api_key)

    @property
    def vision_api_key_value(self) -> str | None:
        return self.vision_api_key.get_secret_value() if self.vision_api_key else None

    @property
    def smtp_password_value(self) -> str | None:
        return self.smtp_password.get_secret_value() if self.smtp_password else None

    @property
    def session_pepper_value(self) -> str:
        return self.session_pepper.get_secret_value()

    @property
    def s3_access_key_value(self) -> str | None:
        return self.s3_access_key.get_secret_value() if self.s3_access_key else None

    @property
    def s3_secret_key_value(self) -> str | None:
        return self.s3_secret_key.get_secret_value() if self.s3_secret_key else None

    @property
    def rate_limit_url_value(self) -> str | None:
        return self.rate_limit_url.get_secret_value() if self.rate_limit_url else None

    def validate_production(self) -> None:
        if self.environment.lower() != "production":
            return
        if (
            self.session_pepper_value == "development-only-change-before-production"
            or len(self.session_pepper_value) < 32
        ):
            raise RuntimeError(
                "GRADEFLOW_SESSION_PEPPER must be a unique secret of at least 32 characters outside development"
            )
        if not self.cookie_secure:
            raise RuntimeError("GRADEFLOW_COOKIE_SECURE must be true in production")
        if not self.database_url.startswith(("postgresql://", "postgresql+psycopg://")):
            raise RuntimeError("Production GradeFlow requires the requested PostgreSQL database")
        if self.auto_create_schema:
            raise RuntimeError(
                "Disable GRADEFLOW_AUTO_CREATE_SCHEMA in production and apply Alembic migrations"
            )
        if not self.rate_limit_url_value or not self.rate_limit_url_value.startswith(
            ("redis://", "rediss://")
        ):
            raise RuntimeError("Production requires a shared Redis rate limiter")
        if self.storage_backend != "s3" or not (
            self.s3_bucket and self.s3_access_key and self.s3_secret_key
        ):
            raise RuntimeError(
                "Production requires configured private S3-compatible object storage"
            )
        if not (self.smtp_host and self.email_from and self.frontend_origin):
            raise RuntimeError(
                "Production requires a school SMTP service and configured frontend origin for account verification"
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
'''

from functools import lru_cache
from pathlib import Path
from typing import Literal
import os


from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from functools import lru_cache
from pathlib import Path
from typing import Literal


# config.py lives at <project>/backend/app/core/, so the project root is 3 levels up
PROJECT_ROOT = Path(__file__).resolve().parents[3]



    
    # ...the rest of the class stays exactly the same
class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="GRADEFLOW_",
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    environment: str = "development"
    database_url: str = "sqlite:///./data/gradeflow.db"
    session_pepper: SecretStr = SecretStr("development-only-change-before-production")
    cookie_secure: bool = True
    auto_create_schema: bool = True
    storage_backend: Literal["local", "supabase"] = "local"
    storage_dir: Path = Path("./storage/private")
    supabase_url: str | None = None
    supabase_storage_bucket: str | None = None
    supabase_service_role_key: SecretStr | None = None
    max_upload_bytes: int = 20 * 1024 * 1024
    rate_limit_url: SecretStr | None = None
    celery_broker_url: str = "redis://localhost:6379/0"
    celery_result_backend: str = "redis://localhost:6379/1"
    vision_base_url: str | None = None
    vision_model: str | None = None
    vision_api_key: SecretStr | None = None
    vision_timeout_seconds: int = 60
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    email_from: str | None = None
    frontend_origin: str | None = None

    @property
    def vision_ready(self) -> bool:
        return bool(self.vision_base_url and self.vision_model and self.vision_api_key)

    @property
    def vision_api_key_value(self) -> str | None:
        return self.vision_api_key.get_secret_value() if self.vision_api_key else None

    @property
    def smtp_password_value(self) -> str | None:
        return self.smtp_password.get_secret_value() if self.smtp_password else None

    @property
    def session_pepper_value(self) -> str:
        return self.session_pepper.get_secret_value()

    @property
    def supabase_service_role_key_value(self) -> str | None:
        return (
            self.supabase_service_role_key.get_secret_value()
            if self.supabase_service_role_key
            else None
        )

    @property
    def rate_limit_url_value(self) -> str | None:
        return self.rate_limit_url.get_secret_value() if self.rate_limit_url else None

    def validate_production(self) -> None:
        if self.environment.lower() != "production":
            return
        if (
            self.session_pepper_value == "development-only-change-before-production"
            or len(self.session_pepper_value) < 32
        ):
            raise RuntimeError(
                "GRADEFLOW_SESSION_PEPPER must be a unique secret of at least 32 characters outside development"
            )
        if not self.cookie_secure:
            raise RuntimeError("GRADEFLOW_COOKIE_SECURE must be true in production")
        if not self.database_url.startswith(("postgresql://", "postgresql+psycopg://")):
            raise RuntimeError("Production GradeFlow requires the requested PostgreSQL database")
        if self.auto_create_schema:
            raise RuntimeError(
                "Disable GRADEFLOW_AUTO_CREATE_SCHEMA in production and apply Alembic migrations"
            )
        if not self.rate_limit_url_value or not self.rate_limit_url_value.startswith(
            ("redis://", "rediss://")
        ):
            raise RuntimeError("Production requires a shared Redis rate limiter")
        if self.storage_backend != "supabase" or not (
            self.supabase_url
            and self.supabase_storage_bucket
            and self.supabase_service_role_key_value
        ):
            raise RuntimeError(
                "Production requires GRADEFLOW_STORAGE_BACKEND=supabase with GRADEFLOW_SUPABASE_URL, "
                "GRADEFLOW_SUPABASE_STORAGE_BUCKET and GRADEFLOW_SUPABASE_SERVICE_ROLE_KEY configured"
            )
        if not (self.smtp_host and self.email_from and self.frontend_origin):
            raise RuntimeError(
                "Production requires a school SMTP service and configured frontend origin for account verification"
            )


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()