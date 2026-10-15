import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

# These paths are test-owned and never resolve to DATABASE_URL or the platform's shared MySQL.
Path("data").mkdir(exist_ok=True)
_TEST_DB = Path("data/gradeflow_pytest.db")
_TEST_DB.unlink(missing_ok=True)
os.environ["GRADEFLOW_ENVIRONMENT"] = "development"
os.environ["GRADEFLOW_DATABASE_URL"] = "sqlite:///./data/gradeflow_pytest.db"
os.environ["GRADEFLOW_SESSION_PEPPER"] = "pytest-only-secret-0123456789-abcdefghijklmnop"
os.environ["GRADEFLOW_COOKIE_SECURE"] = "false"
os.environ["GRADEFLOW_AUTO_CREATE_SCHEMA"] = "true"
os.environ["GRADEFLOW_STORAGE_BACKEND"] = "local"
os.environ["GRADEFLOW_STORAGE_DIR"] = "./storage/pytest-private"
os.environ["GRADEFLOW_RATE_LIMIT_URL"] = ""
os.environ["GRADEFLOW_VISION_BASE_URL"] = ""
os.environ["GRADEFLOW_VISION_MODEL"] = ""
os.environ["GRADEFLOW_VISION_API_KEY"] = ""


@pytest.fixture
def client():
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def csrf_headers(client: TestClient) -> dict[str, str]:
    token = client.cookies.get("gradeflow_csrf")
    return {"X-CSRF-Token": token} if token else {}


def register_and_verify(
    client: TestClient,
    email: str,
    *,
    full_name: str = "Test Teacher",
    school_name: str = "Example School",
    password: str = "correct-horse-battery-staple",
) -> dict:
    response = client.post(
        "/api/v1/auth/register",
        json={
            "full_name": full_name,
            "email": email,
            "password": password,
            "school_name": school_name,
        },
    )
    assert response.status_code == 201, response.text
    link = response.json()["verification_path"]
    token = parse_qs(urlsplit(link).query)["token"][0]
    verified = client.post("/api/v1/auth/verify-email", json={"token": token})
    assert verified.status_code == 200, verified.text
    return verified.json()
