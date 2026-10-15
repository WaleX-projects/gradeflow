from datetime import datetime, timezone
from typing import Annotated

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.security import hash_session_token
from app.database import get_db
from app.models import AuthSession, OrganizationMembership, User


def get_current_membership(
    db: Annotated[Session, Depends(get_db)],
    gradeflow_session: Annotated[str | None, Cookie()] = None,
) -> OrganizationMembership:
    if not gradeflow_session:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to continue")
    token_hash = hash_session_token(gradeflow_session)
    auth_session = db.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash))
    now = datetime.now(timezone.utc)
    expiry = (
        auth_session.expires_at
        if auth_session and auth_session.expires_at.tzinfo
        else (auth_session.expires_at.replace(tzinfo=timezone.utc) if auth_session else now)
    )
    if not auth_session or auth_session.revoked_at or expiry <= now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session is expired or revoked")
    user = db.get(User, auth_session.user_id)
    if not user or not user.is_active or not user.is_email_verified:
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Account is inactive or email is unverified"
        )
    membership_query = select(OrganizationMembership).where(
        OrganizationMembership.user_id == user.id, OrganizationMembership.is_active.is_(True)
    )
    if auth_session.organization_id:
        membership_query = membership_query.where(
            OrganizationMembership.organization_id == auth_session.organization_id
        )
    membership = db.scalar(membership_query.order_by(OrganizationMembership.created_at))
    if not membership:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "No school workspace is assigned to this account"
        )
    return membership


def require_roles(*roles: str):
    def guard(
        membership: Annotated[OrganizationMembership, Depends(get_current_membership)],
    ) -> OrganizationMembership:
        if membership.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your role cannot perform this action")
        return membership

    return guard


def current_user(
    db: Annotated[Session, Depends(get_db)],
    membership: Annotated[OrganizationMembership, Depends(get_current_membership)],
) -> User:
    return db.get(User, membership.user_id)
