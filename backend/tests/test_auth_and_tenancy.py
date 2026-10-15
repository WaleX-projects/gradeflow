from uuid import UUID, uuid4
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from app.models import AuthSession, OrganizationMembership
from app.database import SessionLocal
from conftest import csrf_headers, register_and_verify


def test_verification_sessions_rotation_and_password_reset(client):
    account = {
        "full_name": "Amina Marker",
        "email": "auth-flow@example.test",
        "password": "correct-horse-battery-staple",
        "school_name": "River School",
    }
    registration = client.post("/api/v1/auth/register", json=account)
    assert registration.status_code == 201
    assert (
        client.post(
            "/api/v1/auth/login", json={"email": account["email"], "password": account["password"]}
        ).status_code
        == 403
    )

    token = parse_qs(urlsplit(registration.json()["verification_path"]).query)["token"][0]
    assert client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 200
    assert client.get("/api/v1/auth/me").json()["email"] == account["email"]
    old_session = next(
        item for item in client.get("/api/v1/auth/sessions").json() if item["current"]
    )
    old_token = client.cookies.get("gradeflow_session")

    refreshed = client.post("/api/v1/auth/refresh", headers=csrf_headers(client))
    assert refreshed.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 200
    # A copied pre-rotation cookie must no longer authorize a separate browser.
    with TestClient(client.app) as old_browser:
        old_browser.cookies.set("gradeflow_session", old_token)
        assert old_browser.get("/api/v1/auth/me").status_code == 401
    with SessionLocal() as db:
        session = db.get(AuthSession, UUID(old_session["id"]))
        assert session is None or session.revoked_at is not None

    response = client.post("/api/v1/auth/forgot-password", json={"email": account["email"]})
    assert response.status_code == 202
    reset_token = parse_qs(urlsplit(response.json()["reset_path"]).query)["token"][0]
    assert (
        client.post(
            "/api/v1/auth/reset-password",
            json={"token": reset_token, "new_password": "another-correct-horse-battery"},
        ).status_code
        == 204
    )
    assert client.get("/api/v1/auth/me").status_code == 401
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"email": account["email"], "password": "another-correct-horse-battery"},
        ).status_code
        == 200
    )


def test_expired_or_reused_email_action_is_rejected(client):
    registration = client.post(
        "/api/v1/auth/register",
        json={
            "full_name": "Test Person",
            "email": "one-use@example.test",
            "password": "correct-horse-battery-staple",
            "school_name": "One Use School",
        },
    )
    token = parse_qs(urlsplit(registration.json()["verification_path"]).query)["token"][0]
    assert client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 200
    assert client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 400


def test_cross_school_records_are_not_visible_and_roles_are_server_enforced(client):
    first = register_and_verify(client, "school-a@example.test", school_name="School A")
    with SessionLocal() as db:
        owner_membership = (
            db.query(OrganizationMembership)
            .filter_by(user_id=UUID(first["id"]), organization_id=UUID(first["organization_id"]))
            .one()
        )
        assert owner_membership.role == "owner"
    headers_a = csrf_headers(client)
    year = client.post(
        "/api/v1/academics/years",
        json={"label": "2025/2026", "is_current": True},
        headers=headers_a,
    ).json()
    klass = client.post(
        "/api/v1/academics/classes", json={"name": "JSS 1"}, headers=csrf_headers(client)
    ).json()
    student = client.post(
        "/api/v1/students",
        json={
            "admission_number": "A-001",
            "first_name": "Pupil",
            "last_name": "One",
            "class_id": klass["id"],
            "academic_year_id": year["id"],
        },
        headers=csrf_headers(client),
    ).json()

    with client.__class__(client.app) as other:
        second = register_and_verify(other, "school-b@example.test", school_name="School B")
        assert second["organization_id"] != first["organization_id"]
        assert other.get(f"/api/v1/students/{student['id']}").status_code == 404
        assert other.get("/api/v1/students").json()["total"] == 0
        # The existing member is granted explicit read-only membership in school A.
        with SessionLocal() as db:
            db.add(
                OrganizationMembership(
                    organization_id=UUID(first["organization_id"]),
                    user_id=UUID(second["id"]),
                    role="viewer",
                    is_active=True,
                )
            )
            db.commit()
        switched = other.post(
            f"/api/v1/auth/workspaces/{first['organization_id']}/select",
            headers=csrf_headers(other),
        )
        assert switched.status_code == 200 and switched.json()["role"] == "viewer"
        assert other.get(f"/api/v1/students/{student['id']}").status_code == 200
        rejected = other.post(
            "/api/v1/academics/classes",
            json={"name": "Unauthorized write"},
            headers=csrf_headers(other),
        )
        assert rejected.status_code == 403


def test_login_attempts_are_limited_per_account(client):
    email = f"throttle-{uuid4()}@example.test"
    responses = [
        client.post("/api/v1/auth/login", json={"email": email, "password": "incorrect"})
        for _ in range(11)
    ]
    assert all(response.status_code == 401 for response in responses[:10])
    assert responses[-1].status_code == 429
    assert int(responses[-1].headers["retry-after"]) > 0
