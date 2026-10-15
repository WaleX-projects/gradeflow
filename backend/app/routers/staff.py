from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.dependencies import require_roles
from app.core.security import hash_password, hash_session_token, new_session_token, verify_password
from app.database import get_db
from app.models import AuditEvent, Invitation, OrganizationMembership, User
from app.routers.auth import _create_session
from app.schemas.contracts import (
    InvitationAccept,
    InvitationCreate,
    StaffActivationUpdate,
    StaffRoleUpdate,
)
from app.services.email import mail_ready, send_account_email

router = APIRouter(tags=["organizations and staff"])
STAFF_MANAGERS = ("owner", "school_admin")
ALLOWED_ROLES = {"owner", "school_admin", "exam_officer", "teacher_marker", "reviewer", "viewer"}


def _audit(
    db: Session,
    org_id: UUID,
    actor: UUID | None,
    action: str,
    entity: UUID,
    details: dict | None = None,
):
    db.add(
        AuditEvent(
            organization_id=org_id,
            actor_user_id=actor,
            action=action,
            entity_type="staff",
            entity_id=entity,
            details=details or {},
        )
    )


def _invite_link(token: str) -> str:
    return f"/accept-invite?token={token}"


@router.get("/staff")
def list_staff(
    membership: OrganizationMembership = Depends(require_roles(*STAFF_MANAGERS)),
    db: Session = Depends(get_db),
):
    rows = db.execute(
        select(OrganizationMembership, User)
        .join(User, User.id == OrganizationMembership.user_id)
        .where(OrganizationMembership.organization_id == membership.organization_id)
        .order_by(OrganizationMembership.created_at)
    ).all()
    return [
        {
            "membership_id": m.id,
            "user_id": user.id,
            "full_name": user.full_name,
            "email": user.email,
            "role": m.role,
            "is_active": m.is_active,
            "is_email_verified": user.is_email_verified,
            "joined_at": m.created_at,
        }
        for m, user in rows
    ]


@router.get("/staff/invitations")
def list_invitations(
    membership: OrganizationMembership = Depends(require_roles(*STAFF_MANAGERS)),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Invitation)
        .where(Invitation.organization_id == membership.organization_id)
        .order_by(Invitation.created_at.desc())
    ).all()
    now = datetime.now(timezone.utc)
    result = []
    for invite in rows:
        expires = (
            invite.expires_at
            if invite.expires_at.tzinfo
            else invite.expires_at.replace(tzinfo=timezone.utc)
        )
        result.append(
            {
                "id": invite.id,
                "email": invite.email,
                "role": invite.role,
                "created_at": invite.created_at,
                "expires_at": invite.expires_at,
                "accepted_at": invite.accepted_at,
                "revoked_at": invite.revoked_at,
                "expired": expires <= now,
            }
        )
    return result


@router.post("/staff/invitations", status_code=201)
def create_invitation(
    payload: InvitationCreate,
    membership: OrganizationMembership = Depends(require_roles(*STAFF_MANAGERS)),
    db: Session = Depends(get_db),
):
    existing = db.scalar(
        select(User)
        .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
        .where(
            User.email == payload.email,
            OrganizationMembership.organization_id == membership.organization_id,
        )
    )
    if existing:
        raise HTTPException(409, "This person already has a school membership")
    now = datetime.now(timezone.utc)
    pending = db.scalar(
        select(Invitation).where(
            Invitation.organization_id == membership.organization_id,
            Invitation.email == payload.email,
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
            Invitation.expires_at > now,
        )
    )
    if pending:
        raise HTTPException(409, "An invitation is already pending for this email")
    raw = new_session_token()
    invitation = Invitation(
        organization_id=membership.organization_id,
        email=payload.email,
        role=payload.role,
        token_hash=hash_session_token(raw),
        expires_at=now + timedelta(days=7),
        invited_by=membership.user_id,
    )
    db.add(invitation)
    db.flush()
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "staff.invitation_created",
        invitation.id,
        {"role": payload.role},
    )
    db.commit()
    path = _invite_link(raw)
    if mail_ready():
        if not send_account_email(payload.email, "You're invited to GradeFlow", path):
            raise HTTPException(
                503,
                "The invitation is recorded, but school email could not send it. Revoke and retry after checking mail configuration.",
            )
        invite_path = None
    elif settings.environment.lower() == "development":
        invite_path = path
    else:
        raise HTTPException(
            503, "The invitation is recorded, but email delivery is not configured."
        )
    return {
        "id": invitation.id,
        "email": invitation.email,
        "role": invitation.role,
        "expires_at": invitation.expires_at,
        "invitation_path": invite_path,
        "message": "Invitation sent."
        if invite_path is None
        else "Development email is not configured; use the one-time invitation link.",
    }


@router.delete("/staff/invitations/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_invitation(
    invitation_id: UUID,
    membership: OrganizationMembership = Depends(require_roles(*STAFF_MANAGERS)),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(Invitation).where(
            Invitation.id == invitation_id, Invitation.organization_id == membership.organization_id
        )
    )
    if not row or row.accepted_at or row.revoked_at:
        raise HTTPException(404, "Pending invitation not found")
    row.revoked_at = datetime.now(timezone.utc)
    _audit(db, membership.organization_id, membership.user_id, "staff.invitation_revoked", row.id)
    db.commit()


@router.post("/staff/invitations/accept", status_code=201)
def accept_invitation(payload: InvitationAccept, response: Response, db: Session = Depends(get_db)):
    invitation = db.scalar(
        select(Invitation).where(Invitation.token_hash == hash_session_token(payload.token))
    )
    now = datetime.now(timezone.utc)
    if not invitation or invitation.accepted_at or invitation.revoked_at:
        raise HTTPException(400, "This invitation is invalid or has already been used")
    expires = (
        invitation.expires_at
        if invitation.expires_at.tzinfo
        else invitation.expires_at.replace(tzinfo=timezone.utc)
    )
    if expires <= now:
        raise HTTPException(
            400, "This invitation has expired. Ask a school administrator to send another."
        )
    user = db.scalar(select(User).where(User.email == invitation.email))
    if user:
        if not verify_password(payload.password, user.password_hash):
            raise HTTPException(
                401,
                "An account already exists for this email. Enter that account's password to accept the invitation.",
            )
        if not user.is_active:
            raise HTTPException(403, "This account has been deactivated")
        user.is_email_verified = True
    else:
        user = User(
            email=invitation.email,
            full_name=payload.full_name.strip(),
            password_hash=hash_password(payload.password),
            is_active=True,
            is_email_verified=True,
        )
        db.add(user)
        db.flush()
    membership = OrganizationMembership(
        organization_id=invitation.organization_id,
        user_id=user.id,
        role=invitation.role,
        is_active=True,
    )
    db.add(membership)
    db.flush()
    invitation.accepted_at = now
    _audit(
        db,
        invitation.organization_id,
        user.id,
        "staff.invitation_accepted",
        invitation.id,
        {"role": invitation.role},
    )
    _create_session(db, user, response, membership.organization_id)
    db.commit()
    return {
        "id": user.id,
        "email": user.email,
        "full_name": user.full_name,
        "role": membership.role,
        "organization_id": membership.organization_id,
    }


@router.patch("/staff/{membership_id}/role")
def update_role(
    membership_id: UUID,
    payload: StaffRoleUpdate,
    membership: OrganizationMembership = Depends(require_roles(*STAFF_MANAGERS)),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.id == membership_id,
            OrganizationMembership.organization_id == membership.organization_id,
        )
    )
    if not row:
        raise HTTPException(404, "Staff membership not found")
    if row.role == "owner" and payload.role != "owner":
        active_owners = db.scalar(
            select(OrganizationMembership.id)
            .where(
                OrganizationMembership.organization_id == membership.organization_id,
                OrganizationMembership.role == "owner",
                OrganizationMembership.is_active.is_(True),
            )
            .limit(2)
        )
        if active_owners == row.id:
            count = len(
                db.scalars(
                    select(OrganizationMembership.id)
                    .where(
                        OrganizationMembership.organization_id == membership.organization_id,
                        OrganizationMembership.role == "owner",
                        OrganizationMembership.is_active.is_(True),
                    )
                    .limit(2)
                ).all()
            )
            if count <= 1:
                raise HTTPException(409, "A school must retain at least one active owner")
    row.role = payload.role
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "staff.role_changed",
        row.id,
        {"role": payload.role},
    )
    db.commit()
    return {"membership_id": row.id, "role": row.role, "is_active": row.is_active}


@router.patch("/staff/{membership_id}/activation")
def set_staff_activation(
    membership_id: UUID,
    payload: StaffActivationUpdate,
    membership: OrganizationMembership = Depends(require_roles(*STAFF_MANAGERS)),
    db: Session = Depends(get_db),
):
    row = db.scalar(
        select(OrganizationMembership).where(
            OrganizationMembership.id == membership_id,
            OrganizationMembership.organization_id == membership.organization_id,
        )
    )
    if not row:
        raise HTTPException(404, "Staff membership not found")
    if row.user_id == membership.user_id and not payload.is_active:
        raise HTTPException(409, "You cannot deactivate your own active school membership")
    if row.role == "owner" and not payload.is_active:
        active_owners = db.scalars(
            select(OrganizationMembership.id)
            .where(
                OrganizationMembership.organization_id == membership.organization_id,
                OrganizationMembership.role == "owner",
                OrganizationMembership.is_active.is_(True),
            )
            .limit(2)
        ).all()
        if len(active_owners) <= 1:
            raise HTTPException(409, "A school must retain at least one active owner")
    row.is_active = payload.is_active
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "staff.membership_activated" if payload.is_active else "staff.membership_deactivated",
        row.id,
    )
    db.commit()
    return {"membership_id": row.id, "is_active": row.is_active}
