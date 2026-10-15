import asyncio
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.dependencies import get_current_membership
from app.core.security import hash_password, hash_session_token, new_session_token, verify_password
from app.core.rate_limit import enforce_auth_attempts
from app.database import get_db
from app.models import AuthSession, EmailActionToken, Organization, OrganizationMembership, User
from app.schemas.contracts import (
    ForgotPasswordRequest,
    ForgotPasswordResponse,
    LoginRequest,
    PasswordChange,
    PasswordResetRequest,
    ProfileUpdate,
    RegisterRequest,
    RegisterResponse,
    TokenRequest,
    UserView,
)
from app.services.email import mail_ready, send_account_email

router = APIRouter(prefix="/auth", tags=["authentication"])
COOKIE_NAME = "gradeflow_session"
CSRF_COOKIE = "gradeflow_csrf"
SESSION_DAYS = 7


def _set_session_cookies(response: Response, token: str) -> None:
    secure = settings.cookie_secure
    same_site = "none" if secure else "lax"
    response.set_cookie(
        COOKIE_NAME,
        token,
        httponly=True,
        secure=secure,
        samesite=same_site,
        max_age=SESSION_DAYS * 86400,
        path="/",
    )
    csrf = secrets.token_urlsafe(32)
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        httponly=False,
        secure=secure,
        samesite=same_site,
        max_age=SESSION_DAYS * 86400,
        path="/",
    )


def _create_session(
    db: Session, user: User, response: Response, organization_id: UUID | None = None
) -> None:
    if organization_id is None:
        organization_id = db.scalar(
            select(OrganizationMembership.organization_id)
            .where(
                OrganizationMembership.user_id == user.id,
                OrganizationMembership.is_active.is_(True),
            )
            .order_by(OrganizationMembership.created_at)
        )
    if organization_id is None:
        raise HTTPException(403, "No school workspace is assigned to this account")
    token = new_session_token()
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    db.add(
        AuthSession(
            user_id=user.id,
            organization_id=organization_id,
            token_hash=hash_session_token(token),
            expires_at=expires,
        )
    )
    _set_session_cookies(response, token)


def _clear_cookies(response: Response) -> None:
    secure = settings.cookie_secure
    same_site = "none" if secure else "lax"
    response.delete_cookie(COOKIE_NAME, path="/", secure=secure, httponly=True, samesite=same_site)
    response.delete_cookie(CSRF_COOKIE, path="/", secure=secure, httponly=False, samesite=same_site)


def _user_view(db: Session, user: User, membership: OrganizationMembership) -> UserView:
    org = db.get(Organization, membership.organization_id)
    return UserView(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=membership.role,
        organization_id=membership.organization_id,
        organization_name=org.name if org else "School workspace",
    )


def _create_action_token(db: Session, user: User, purpose: str, ttl: timedelta) -> str:
    now = datetime.now(timezone.utc)
    old_tokens = db.scalars(
        select(EmailActionToken).where(
            EmailActionToken.user_id == user.id,
            EmailActionToken.purpose == purpose,
            EmailActionToken.consumed_at.is_(None),
        )
    ).all()
    for old in old_tokens:
        old.consumed_at = now
    raw = new_session_token()
    db.add(
        EmailActionToken(
            user_id=user.id,
            token_hash=hash_session_token(raw),
            purpose=purpose,
            expires_at=now + ttl,
        )
    )
    db.flush()
    return raw


def _action_path(purpose: str, token: str) -> str:
    route = "verify" if purpose == "verify_email" else "reset-password"
    return f"/{route}?token={quote(token)}"


async def _deliver_or_development_link(recipient: str, purpose: str, token: str) -> str | None:
    path = _action_path(purpose, token)
    if mail_ready():
        subject = (
            "Verify your GradeFlow email"
            if purpose == "verify_email"
            else "Reset your GradeFlow password"
        )
        if await asyncio.to_thread(send_account_email, recipient, subject, path):
            return None
        raise HTTPException(
            503,
            "The school mail service could not send this message. Ask an administrator to check email configuration and retry.",
        )
    if settings.environment.lower() == "development":
        return path
    raise HTTPException(
        503, "School email delivery is not configured. Ask an administrator before retrying."
    )


def _valid_action(db: Session, raw_token: str, purpose: str) -> tuple[EmailActionToken, User]:
    row = db.scalar(
        select(EmailActionToken).where(
            EmailActionToken.token_hash == hash_session_token(raw_token),
            EmailActionToken.purpose == purpose,
            EmailActionToken.consumed_at.is_(None),
        )
    )
    now = datetime.now(timezone.utc)
    if not row:
        raise HTTPException(400, "This link is invalid or has already been used")
    expiry = (
        row.expires_at if row.expires_at.tzinfo else row.expires_at.replace(tzinfo=timezone.utc)
    )
    if expiry <= now:
        raise HTTPException(400, "This link has expired. Request a new one.")
    user = db.get(User, row.user_id)
    if not user or not user.is_active:
        raise HTTPException(400, "This account is no longer available")
    return row, user


def _default_membership(db: Session, user: User) -> OrganizationMembership:
    membership = db.scalar(
        select(OrganizationMembership)
        .where(
            OrganizationMembership.user_id == user.id, OrganizationMembership.is_active.is_(True)
        )
        .order_by(OrganizationMembership.created_at)
    )
    if not membership:
        raise HTTPException(403, "No school workspace is assigned to this account")
    return membership


def _session_for_token(db: Session, token: str | None) -> tuple[AuthSession, User]:
    if not token:
        raise HTTPException(401, "Sign in to continue")
    session = db.scalar(
        select(AuthSession).where(AuthSession.token_hash == hash_session_token(token))
    )
    now = datetime.now(timezone.utc)
    if not session or session.revoked_at:
        raise HTTPException(401, "Session is expired or revoked")
    expiry = (
        session.expires_at
        if session.expires_at.tzinfo
        else session.expires_at.replace(tzinfo=timezone.utc)
    )
    if expiry <= now:
        raise HTTPException(401, "Session is expired or revoked")
    user = db.get(User, session.user_id)
    if not user or not user.is_active or not user.is_email_verified:
        raise HTTPException(401, "Account is inactive or unverified")
    return session, user


@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
async def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    await enforce_auth_attempts("register", payload.email)
    if db.scalar(select(User).where(User.email == payload.email)):
        raise HTTPException(
            409, "An account with this email already exists. Sign in or request a password reset."
        )
    organization = Organization(name=payload.school_name.strip())
    user = User(
        email=payload.email,
        full_name=payload.full_name.strip(),
        password_hash=hash_password(payload.password),
        is_email_verified=False,
    )
    db.add_all([organization, user])
    db.flush()
    db.add(OrganizationMembership(organization_id=organization.id, user_id=user.id, role="owner"))
    token = _create_action_token(db, user, "verify_email", timedelta(hours=24))
    db.commit()
    verification_path = await _deliver_or_development_link(user.email, "verify_email", token)
    return RegisterResponse(
        requires_verification=True,
        message="Check your email for the verification link."
        if verification_path is None
        else "Development email is not configured. Use this one-time verification link to continue.",
        verification_path=verification_path,
    )


@router.post("/verify-email", response_model=UserView)
def verify_email(payload: TokenRequest, response: Response, db: Session = Depends(get_db)):
    token_row, user = _valid_action(db, payload.token, "verify_email")
    token_row.consumed_at = datetime.now(timezone.utc)
    user.is_email_verified = True
    _create_session(db, user, response)
    membership = _default_membership(db, user)
    db.commit()
    return _user_view(db, user, membership)


@router.post("/verify-email/resend", response_model=ForgotPasswordResponse)
async def resend_verification(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    await enforce_auth_attempts("verify_resend", payload.email)
    user = db.scalar(select(User).where(User.email == payload.email))
    if user and not user.is_email_verified and user.is_active:
        token = _create_action_token(db, user, "verify_email", timedelta(hours=24))
        db.commit()
        path = await _deliver_or_development_link(user.email, "verify_email", token)
        return ForgotPasswordResponse(
            message="If the account needs verification, a new link has been sent.", reset_path=path
        )
    return ForgotPasswordResponse(
        message="If the account needs verification, a new link has been sent."
    )


@router.post("/login", response_model=UserView)
async def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)):
    await enforce_auth_attempts("login", payload.email)
    user = db.scalar(select(User).where(User.email == payload.email))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has been deactivated")
    if not user.is_email_verified:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Verify your email before signing in")
    membership = _default_membership(db, user)
    _create_session(db, user, response, membership.organization_id)
    db.commit()
    return _user_view(db, user, membership)


@router.get("/me", response_model=UserView)
def me(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    user = db.get(User, membership.user_id)
    return _user_view(db, user, membership)


@router.get("/workspaces")
def workspaces(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(OrganizationMembership, Organization)
        .join(Organization, Organization.id == OrganizationMembership.organization_id)
        .where(
            OrganizationMembership.user_id == membership.user_id,
            OrganizationMembership.is_active.is_(True),
        )
        .order_by(Organization.name)
    ).all()
    return [
        {
            "id": item.organization_id,
            "name": organization.name,
            "role": item.role,
            "active": item.organization_id == membership.organization_id,
        }
        for item, organization in rows
    ]


@router.post("/workspaces/{organization_id}/select", response_model=UserView)
def select_workspace(
    organization_id: UUID,
    response: Response,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
    token: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    user = db.get(User, membership.user_id)
    target = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.user_id == user.id,
            OrganizationMembership.organization_id == organization_id,
            OrganizationMembership.is_active.is_(True),
        )
    )
    if not target:
        raise HTTPException(404, "School workspace not found")
    old_session = db.scalar(
        select(AuthSession).where(
            AuthSession.token_hash == hash_session_token(token or ""),
            AuthSession.revoked_at.is_(None),
        )
    )
    if old_session:
        old_session.revoked_at = datetime.now(timezone.utc)
    _create_session(db, user, response, target.organization_id)
    db.commit()
    return _user_view(db, user, target)


@router.patch("/profile", response_model=UserView)
def update_profile(
    payload: ProfileUpdate,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    user = db.get(User, membership.user_id)
    user.full_name = payload.full_name.strip()
    db.commit()
    return _user_view(db, user, membership)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    db: Session = Depends(get_db),
    token: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    if token:
        session = db.scalar(
            select(AuthSession).where(AuthSession.token_hash == hash_session_token(token))
        )
        if session and not session.revoked_at:
            session.revoked_at = datetime.now(timezone.utc)
            db.commit()
    _clear_cookies(response)


@router.post("/refresh", response_model=UserView)
def refresh_session(
    response: Response,
    db: Session = Depends(get_db),
    token: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    session, user = _session_for_token(db, token)
    session.revoked_at = datetime.now(timezone.utc)
    membership = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.user_id == user.id,
            OrganizationMembership.organization_id == session.organization_id,
            OrganizationMembership.is_active.is_(True),
        )
    )
    if not membership:
        raise HTTPException(403, "The selected school workspace is no longer available")
    _create_session(db, user, response, membership.organization_id)
    db.commit()
    return _user_view(db, user, membership)


@router.get("/sessions")
def sessions(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
    token: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    current_hash = hash_session_token(token) if token else ""
    now = datetime.now(timezone.utc)
    rows = db.scalars(
        select(AuthSession)
        .where(
            AuthSession.user_id == membership.user_id,
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > now,
        )
        .order_by(AuthSession.created_at.desc())
    ).all()
    return [
        {
            "id": str(row.id),
            "created_at": row.created_at,
            "expires_at": row.expires_at,
            "current": row.token_hash == current_hash,
        }
        for row in rows
    ]


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_session(
    session_id: UUID,
    response: Response,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
    token: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    row = db.scalar(
        select(AuthSession).where(
            AuthSession.id == session_id,
            AuthSession.user_id == membership.user_id,
            AuthSession.revoked_at.is_(None),
        )
    )
    if not row:
        raise HTTPException(404, "Session not found")
    row.revoked_at = datetime.now(timezone.utc)
    db.commit()
    if token and row.token_hash == hash_session_token(token):
        _clear_cookies(response)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChange,
    response: Response,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
    token: str | None = Cookie(default=None, alias=COOKIE_NAME),
):
    user = db.get(User, membership.user_id)
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    user.password_hash = hash_password(payload.new_password)
    for session in db.scalars(
        select(AuthSession).where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
    ).all():
        session.revoked_at = datetime.now(timezone.utc)
    _create_session(db, user, response, membership.organization_id)
    db.commit()


@router.post("/forgot-password", response_model=ForgotPasswordResponse, status_code=202)
async def forgot_password(payload: ForgotPasswordRequest, db: Session = Depends(get_db)):
    await enforce_auth_attempts("password_reset", payload.email)
    generic = (
        "If an active account exists for this address, password-reset instructions will be sent."
    )
    user = db.scalar(
        select(User).where(
            User.email == payload.email, User.is_active.is_(True), User.is_email_verified.is_(True)
        )
    )
    if not user:
        return ForgotPasswordResponse(message=generic)
    token = _create_action_token(db, user, "reset_password", timedelta(minutes=30))
    db.commit()
    path = await _deliver_or_development_link(user.email, "reset_password", token)
    return ForgotPasswordResponse(message=generic, reset_path=path)


@router.post("/reset-password", status_code=204)
def reset_password(payload: PasswordResetRequest, db: Session = Depends(get_db)):
    row, user = _valid_action(db, payload.token, "reset_password")
    row.consumed_at = datetime.now(timezone.utc)
    user.password_hash = hash_password(payload.new_password)
    for session in db.scalars(
        select(AuthSession).where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
    ).all():
        session.revoked_at = datetime.now(timezone.utc)
    db.commit()
