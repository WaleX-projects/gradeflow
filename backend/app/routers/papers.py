import hashlib
import io
from pathlib import Path
from uuid import UUID, uuid4

import fitz
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile, status
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.dependencies import get_current_membership, require_roles
from app.database import get_db
from app.models import (
    Exam,
    ExtractionResult,
    Grade,
    GradingRun,
    OrganizationMembership,
    Paper,
    PaperFile,
    PaperPage,
    ProcessingJob,
    Rubric,
    RubricItem,
    Student,
    StudentEnrollment,
    UploadBatch,
)
from app.schemas.contracts import (
    ExtractionUpdate,
    GroupPageList,
    OrganizeScripts,
    PageOrderUpdate,
    PageUpdate,
    StudentAssignmentUpdate,
)
from app.services.audit import record_audit as _audit
from app.services.private_storage import private_storage

router = APIRouter(tags=["papers and processing"])


@router.get("/exams/{exam_id}/unorganized-pages", response_model=GroupPageList)
def list_unorganized_pages(
    exam_id: UUID,
    page: int = Query(1, ge=1),
    page_size: int = Query(40, ge=1, le=100),
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    _org_record(db, Exam, exam_id, org, "Examination not found")
    filters = (
        PaperPage.organization_id == org,
        PaperPage.paper_id == Paper.id,
        Paper.organization_id == org,
        Paper.exam_id == exam_id,
        Paper.upload_batch_id.is_not(None),
        Paper.status != "organized",
    )
    total = int(
        db.scalar(
            select(func.count())
            .select_from(PaperPage)
            .join(Paper, PaperPage.paper_id == Paper.id)
            .where(*filters)
        )
        or 0
    )
    rows = db.execute(
        select(PaperPage, Paper)
        .join(Paper, PaperPage.paper_id == Paper.id)
        .where(*filters)
        .order_by(Paper.created_at, PaperPage.page_number)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return {
        "items": [
            {
                "id": item.id,
                "paper_id": paper.id,
                "source_paper_id": item.source_paper_id,
                "source_page_number": item.source_page_number,
                "rendered_page_number": item.rendered_page_number,
                "page_number": item.page_number,
                "rotation": item.rotation,
                "flagged": item.flagged,
                "file_name": paper.file_name,
            }
            for item, paper in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


UPLOAD_TYPES = {
    ".pdf": ("application/pdf", lambda b: b.startswith(b"%PDF-")),
    ".png": ("image/png", lambda b: b.startswith(b"\x89PNG\r\n\x1a\n")),
    ".jpg": ("image/jpeg", lambda b: b.startswith(b"\xff\xd8\xff")),
    ".jpeg": ("image/jpeg", lambda b: b.startswith(b"\xff\xd8\xff")),
    ".webp": ("image/webp", lambda b: b.startswith(b"RIFF") and b[8:12] == b"WEBP"),
    ".tif": ("image/tiff", lambda b: b.startswith((b"II*\x00", b"MM\x00*"))),
    ".tiff": ("image/tiff", lambda b: b.startswith((b"II*\x00", b"MM\x00*"))),
}
MANAGERS = ("owner", "school_admin", "exam_officer")


def _org_record(db: Session, model, record_id: UUID, org_id: UUID, message: str):
    row = db.scalar(select(model).where(model.id == record_id, model.organization_id == org_id))
    if row is None:
        raise HTTPException(404, message)
    return row


def _view(paper: Paper):
    return {
        "id": paper.id,
        "exam_id": paper.exam_id,
        "upload_batch_id": paper.upload_batch_id,
        "student_id": paper.student_id,
        "file_name": paper.file_name,
        "content_type": paper.content_type,
        "size_bytes": paper.size_bytes,
        "status": paper.status,
        "created_at": paper.created_at,
    }


def _job_view(job: ProcessingJob):
    return {
        "id": job.id,
        "paper_id": job.paper_id,
        "status": job.status,
        "progress": job.progress,
        "error_message": job.error_message,
    }


def _scoped_job_key(org_id: UUID, paper_id: UUID, task_type: str, raw_key: str | None):
    if raw_key is None:
        return None
    if not raw_key.strip() or len(raw_key) > 128:
        raise HTTPException(422, "Idempotency-Key must contain 1–128 non-whitespace characters")
    return hashlib.sha256(f"{org_id}:{paper_id}:{task_type}:{raw_key}".encode()).hexdigest()


def _active_job(db: Session, paper_id: UUID):
    return db.scalar(
        select(ProcessingJob)
        .where(
            ProcessingJob.paper_id == paper_id,
            ProcessingJob.status.in_(["queued", "processing"]),
        )
        .order_by(ProcessingJob.created_at.desc())
    )


def _existing_job(db: Session, paper_id: UUID, task_type: str, scoped_key: str | None):
    if scoped_key:
        prior = db.scalar(
            select(ProcessingJob).where(ProcessingJob.idempotency_key == scoped_key)
        )
        if prior:
            return prior
    active = _active_job(db, paper_id)
    if active and active.task_type != task_type:
        raise HTTPException(409, f"A {active.task_type} job is already active for this script")
    return active


def _reserve_job(db: Session, paper: Paper, job: ProcessingJob, scoped_key: str | None):
    db.add(job)
    paper.status = "queued"
    try:
        db.commit()
        return job, True
    except IntegrityError:
        db.rollback()
        existing = _existing_job(db, paper.id, job.task_type, scoped_key)
        if existing:
            return existing, False
        raise


def _ensure_evidence_mutable(db: Session, paper: Paper):
    confirmed_grade = db.scalar(
        select(Grade.id)
        .where(Grade.paper_id == paper.id, Grade.confirmed_at.is_not(None))
        .limit(1)
    )
    if confirmed_grade or paper.status == "reviewed":
        raise HTTPException(
            409,
            "Student identity and scan evidence are locked after a teacher confirms marks",
        )
    if _active_job(db, paper.id):
        raise HTTPException(409, "Wait for the active script-processing job before editing evidence")


def _invalidate_prior_analysis(db: Session, paper: Paper, actor_id: UUID, reason: str):
    extraction = db.scalar(
        select(ExtractionResult)
        .where(ExtractionResult.paper_id == paper.id)
        .order_by(ExtractionResult.created_at.desc())
    )
    if extraction:
        extraction.status = "needs_review"
        extraction.confirmed_at = None
        notice = f"{reason}; recheck and confirm the transcription before grading."
        extraction.warnings = list(dict.fromkeys([*extraction.warnings, notice]))[:100]
    for grade in db.scalars(
        select(Grade).where(Grade.paper_id == paper.id, Grade.confirmed_at.is_(None))
    ).all():
        grade.ai_score = None
        grade.ai_confidence = None
        grade.ai_warning = f"Proposal invalidated because {reason.lower()}. Request a new proposal after review."
        grade.explanation = None
        grade.evidence = None
    for run in db.scalars(select(GradingRun).where(GradingRun.paper_id == paper.id)).all():
        if run.status != "invalidated":
            run.status = "invalidated"
    paper.status = "needs_review" if extraction else "uploaded"
    _audit(
        db,
        paper.organization_id,
        actor_id,
        "paper.analysis_invalidated",
        "paper",
        paper.id,
        {"reason": reason},
    )


async def _read_validated(upload: UploadFile) -> tuple[bytes, str, str, int]:
    raw_name = Path(upload.filename or "scan").name
    suffix = Path(raw_name).suffix.lower()
    if suffix not in UPLOAD_TYPES:
        raise HTTPException(415, "Use a PDF, PNG, JPEG, TIFF or WebP scan")
    data = await upload.read(settings.max_upload_bytes + 1)
    await upload.close()
    if not data or len(data) > settings.max_upload_bytes:
        raise HTTPException(
            413, f"File must be between 1 byte and {settings.max_upload_bytes // (1024 * 1024)} MB"
        )
    content_type, signature = UPLOAD_TYPES[suffix]
    if not signature(data):
        raise HTTPException(415, "File contents do not match the declared file type")
    if suffix == ".pdf":
        try:
            doc = fitz.open(stream=data, filetype="pdf")
            pages = doc.page_count
            doc.close()
        except Exception:
            raise HTTPException(415, "The PDF could not be opened")
        if pages < 1 or pages > 100:
            raise HTTPException(422, "A script must contain between 1 and 100 pages")
    else:
        pages = 1
    return data, raw_name[:255], content_type, pages


async def _store_upload(
    upload: UploadFile,
    exam: Exam,
    student_id: UUID | None,
    batch_id: UUID,
    membership: OrganizationMembership,
    db: Session,
):
    org_id = membership.organization_id
    data, file_name, content_type, page_count = await _read_validated(upload)
    digest = hashlib.sha256(data).hexdigest()
    duplicate = db.scalar(
        select(Paper).where(
            Paper.organization_id == org_id, Paper.exam_id == exam.id, Paper.sha256 == digest
        )
    )
    if duplicate:
        raise HTTPException(
            409,
            detail={
                "code": "duplicate_paper",
                "message": "This scan already exists in this examination",
                "paper_id": str(duplicate.id),
            },
        )
    if student_id:
        student = _org_record(db, Student, student_id, org_id, "Student not found")
        enrollment = db.scalar(
            select(StudentEnrollment).where(
                StudentEnrollment.organization_id == org_id,
                StudentEnrollment.student_id == student.id,
                StudentEnrollment.class_id == exam.class_id,
                StudentEnrollment.academic_year_id == exam.academic_year_id,
                StudentEnrollment.ended_at.is_(None),
            )
        )
        if not enrollment:
            raise HTTPException(
                422, "The selected student is not enrolled in this exam class and academic year"
            )
    paper_id = uuid4()
    storage_key = f"{org_id}/{paper_id}/{uuid4()}{Path(file_name).suffix.lower()}"
    private_storage().put(storage_key, data, content_type)
    paper = Paper(
        id=paper_id,
        organization_id=org_id,
        exam_id=exam.id,
        upload_batch_id=batch_id,
        student_id=student_id,
        file_name=file_name,
        storage_key=storage_key,
        content_type=content_type,
        size_bytes=len(data),
        sha256=digest,
        status="uploaded",
    )
    db.add(paper)
    db.flush()
    db.add(
        PaperFile(
            organization_id=org_id,
            paper_id=paper.id,
            storage_key=storage_key,
            file_name=file_name,
            content_type=content_type,
            size_bytes=len(data),
            sha256=digest,
        )
    )
    db.add_all(
        [
            PaperPage(
                organization_id=org_id,
                paper_id=paper.id,
                source_paper_id=paper.id,
                page_number=n,
                source_page_number=n,
                rendered_page_number=n,
            )
            for n in range(1, page_count + 1)
        ]
    )
    try:
        db.commit()
    except Exception:
        db.rollback()
        private_storage().delete(storage_key)
        raise
    return paper


@router.post("/papers", status_code=201)
async def upload_paper(
    exam_id: UUID = Form(...),
    file: UploadFile = File(...),
    student_id: UUID | None = Form(default=None),
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    exam = _org_record(db, Exam, exam_id, membership.organization_id, "Examination not found")
    batch = UploadBatch(
        organization_id=membership.organization_id,
        exam_id=exam.id,
        created_by=membership.user_id,
        total_files=1,
        status="processing",
    )
    db.add(batch)
    db.flush()
    db.commit()
    try:
        paper = await _store_upload(file, exam, student_id, batch.id, membership, db)
    except HTTPException as exc:
        batch = db.get(UploadBatch, batch.id)
        batch.status = "failed"
        batch.rejected_files = 1
        message = (
            exc.detail.get("message", "Upload rejected")
            if isinstance(exc.detail, dict)
            else str(exc.detail)
        )
        batch.errors = [
            {
                "file_name": Path(file.filename or "scan").name[:255],
                "status": exc.status_code,
                "message": message,
            }
        ]
        db.commit()
        raise
    batch = db.get(UploadBatch, batch.id)
    batch.accepted_files = 1
    batch.status = "completed"
    db.commit()
    return {"batch_id": batch.id, "accepted": 1, "rejected": 0, "paper": _view(paper)}


@router.post("/papers/bulk", status_code=201)
async def upload_bulk(
    exam_id: UUID = Form(...),
    files: list[UploadFile] = File(...),
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    if not files or len(files) > 50:
        raise HTTPException(422, "Choose between 1 and 50 paper files")
    exam = _org_record(db, Exam, exam_id, membership.organization_id, "Examination not found")
    batch = UploadBatch(
        organization_id=membership.organization_id,
        exam_id=exam.id,
        created_by=membership.user_id,
        total_files=len(files),
        status="processing",
    )
    db.add(batch)
    db.flush()
    db.commit()
    results = []
    errors = []
    for item in files:
        try:
            row = await _store_upload(item, exam, None, batch.id, membership, db)
            results.append({"ok": True, "paper": _view(row)})
        except HTTPException as exc:
            detail = exc.detail
            message = (
                detail.get("message", "Upload rejected")
                if isinstance(detail, dict)
                else str(detail)
            )
            code = (
                detail.get("code", "upload_rejected")
                if isinstance(detail, dict)
                else "upload_rejected"
            )
            error = {
                "file_name": Path(item.filename or "scan").name[:255],
                "status": exc.status_code,
                "code": code,
                "message": message,
            }
            errors.append(error)
            results.append({"ok": False, **error, "detail": detail})
    accepted = sum(1 for result in results if result["ok"])
    rejected = len(results) - accepted
    batch = db.get(UploadBatch, batch.id)
    batch.accepted_files = accepted
    batch.rejected_files = rejected
    batch.errors = errors
    batch.status = "completed" if not rejected else ("partial" if accepted else "failed")
    db.commit()
    return {
        "batch_id": batch.id,
        "status": batch.status,
        "accepted": accepted,
        "rejected": rejected,
        "files": results,
    }


@router.get("/upload-batches")
def list_upload_batches(
    exam_id: UUID | None = None,
    page: int = Query(1, ge=1),
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    stmt = select(UploadBatch).where(UploadBatch.organization_id == membership.organization_id)
    if exam_id:
        stmt = stmt.where(UploadBatch.exam_id == exam_id)
    rows = db.scalars(
        stmt.order_by(UploadBatch.created_at.desc()).offset((page - 1) * 25).limit(25)
    ).all()
    return [
        {
            "id": row.id,
            "exam_id": row.exam_id,
            "status": row.status,
            "total_files": row.total_files,
            "accepted_files": row.accepted_files,
            "rejected_files": row.rejected_files,
            "errors": row.errors,
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.post("/papers/organize", status_code=201)
def organize_scripts(
    payload: OrganizeScripts,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    exam = _org_record(db, Exam, payload.exam_id, org, "Examination not found")
    flattened = [page_id for group in payload.groups for page_id in group.page_ids]
    if len(flattened) != len(set(flattened)):
        raise HTTPException(422, "A page can belong to only one new script group")
    student_ids = [group.student_id for group in payload.groups if group.student_id]
    if len(student_ids) != len(set(student_ids)):
        raise HTTPException(
            409, "A student can be assigned to only one script group per examination"
        )
    pages_by_id = {
        page.id: page
        for page in db.scalars(
            select(PaperPage).where(PaperPage.organization_id == org, PaperPage.id.in_(flattened))
        ).all()
    }
    if len(pages_by_id) != len(flattened):
        raise HTTPException(404, "One or more selected pages are not available in this school")
    sources: dict[UUID, Paper] = {}
    normalized_groups = []
    for group in payload.groups:
        group_pages = [pages_by_id[page_id] for page_id in group.page_ids]
        for page in group_pages:
            source_script = _org_record(db, Paper, page.paper_id, org, "Source script not found")
            analyzed = db.scalar(
                select(ExtractionResult.id)
                .where(ExtractionResult.paper_id == source_script.id)
                .limit(1)
            )
            if (
                source_script.exam_id != exam.id
                or source_script.status not in {"uploaded", "failed"}
                or analyzed
                or _active_job(db, source_script.id)
            ):
                raise HTTPException(
                    409, "Only unprocessed pages from this examination can be organized"
                )
            origin_id = page.source_paper_id or source_script.id
            origin = sources.get(origin_id)
            if origin is None:
                origin = _org_record(db, Paper, origin_id, org, "Original scan not found")
                sources[origin_id] = origin
            if origin.exam_id != exam.id:
                raise HTTPException(422, "All source pages must belong to the selected examination")
        student_id = group.student_id
        if student_id:
            student = _org_record(db, Student, student_id, org, "Student not found")
            enrolled = db.scalar(
                select(StudentEnrollment.id).where(
                    StudentEnrollment.organization_id == org,
                    StudentEnrollment.student_id == student.id,
                    StudentEnrollment.class_id == exam.class_id,
                    StudentEnrollment.academic_year_id == exam.academic_year_id,
                    StudentEnrollment.ended_at.is_(None),
                )
            )
            if not enrolled:
                raise HTTPException(
                    422, "A selected student must be enrolled in the exam class and academic year"
                )
            existing = db.scalar(
                select(Paper.id)
                .where(
                    Paper.organization_id == org,
                    Paper.exam_id == exam.id,
                    Paper.student_id == student.id,
                    Paper.id.not_in(
                        select(Paper.id).where(
                            Paper.id.in_([pages_by_id[pid].paper_id for pid in group.page_ids])
                        )
                    ),
                )
                .limit(1)
            )
            if existing:
                raise HTTPException(409, "That student already has a script in this examination")
        normalized_groups.append((group, group_pages, student_id))

    saved_keys: list[str] = []
    created = []
    try:
        for group, group_pages, student_id in normalized_groups:
            if len(group_pages) > 100:
                raise HTTPException(422, "A student script can contain at most 100 pages")
            output = fitz.open()
            try:
                for page in group_pages:
                    source_id = page.source_paper_id or page.paper_id
                    source_paper = sources[source_id]
                    if source_paper.content_type == "application/pdf":
                        with private_storage().materialize(source_paper.storage_key) as source_path:
                            with fitz.open(source_path) as source_doc:
                                source_index = page.source_page_number - 1
                                if source_index < 0 or source_index >= source_doc.page_count:
                                    raise HTTPException(
                                        422, "A selected page no longer exists in its source scan"
                                    )
                                source_rotation = source_doc.load_page(source_index).rotation
                                rotation = (source_rotation + page.rotation) % 360
                                output.insert_pdf(
                                    source_doc,
                                    from_page=source_index,
                                    to_page=source_index,
                                    rotate=rotation,
                                )
                    else:
                        from PIL import Image, ImageOps

                        with private_storage().materialize(source_paper.storage_key) as source_path:
                            with Image.open(source_path) as image:
                                image = (
                                    ImageOps.exif_transpose(image)
                                    .convert("RGB")
                                    .rotate(-page.rotation, expand=True)
                                )
                                width, height = image.size
                                scale = min(1.0, 1200 / max(width, height))
                                out_page = output.new_page(
                                    width=max(1, width * scale), height=max(1, height * scale)
                                )
                                image_data = io.BytesIO()
                                image.save(image_data, format="JPEG", quality=90, optimize=True)
                                out_page.insert_image(out_page.rect, stream=image_data.getvalue())
                if output.page_count != len(group_pages):
                    raise HTTPException(422, "Not all selected pages could be assembled")
                data = output.tobytes(garbage=4, deflate=True)
            finally:
                output.close()
            if not data or len(data) > 100 * 1024 * 1024:
                raise HTTPException(413, "A grouped script must be no larger than 100 MB")
            paper_id = uuid4()
            file_name = f"script-{paper_id.hex[:12]}.pdf"
            key = f"{org}/{paper_id}/{uuid4()}.pdf"
            private_storage().put(key, data, "application/pdf")
            saved_keys.append(key)
            digest = hashlib.sha256(data).hexdigest()
            grouped = Paper(
                id=paper_id,
                organization_id=org,
                exam_id=exam.id,
                student_id=student_id,
                file_name=file_name,
                storage_key=key,
                content_type="application/pdf",
                size_bytes=len(data),
                sha256=digest,
                status="uploaded",
            )
            db.add(grouped)
            db.flush()
            db.add(
                PaperFile(
                    organization_id=org,
                    paper_id=grouped.id,
                    storage_key=key,
                    file_name=file_name,
                    content_type="application/pdf",
                    size_bytes=len(data),
                    sha256=digest,
                )
            )
            for number, page in enumerate(group_pages, start=1):
                page.paper_id = grouped.id
                page.page_number = number
                page.rendered_page_number = number
                page.rotation = 0
            created.append(
                {
                    "id": grouped.id,
                    "file_name": file_name,
                    "student_id": grouped.student_id,
                    "page_count": len(group_pages),
                }
            )
        for source in sources.values():
            remaining = db.scalar(
                select(PaperPage.id).where(PaperPage.paper_id == source.id).limit(1)
            )
            if remaining is None:
                source.status = "organized"
        _audit(
            db,
            org,
            membership.user_id,
            "papers.pages_organized",
            "exam",
            exam.id,
            {"script_count": len(created), "page_count": len(flattened)},
        )
        db.commit()
    except Exception:
        db.rollback()
        for key in saved_keys:
            private_storage().delete(key)
        raise
    return {"exam_id": exam.id, "scripts": created, "pages_organized": len(flattened)}


@router.get("/papers")
def list_papers(
    exam_id: UUID | None = None,
    paper_status: str | None = Query(default=None, alias="status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    stmt = select(Paper).where(
        Paper.organization_id == membership.organization_id, Paper.status != "organized"
    )
    if exam_id:
        stmt = stmt.where(Paper.exam_id == exam_id)
    allowed_statuses = {
        "uploaded",
        "queued",
        "processing",
        "needs_review",
        "ready",
        "failed",
        "review",
        "reviewed",
        "grading",
    }
    if paper_status:
        if paper_status not in allowed_statuses:
            raise HTTPException(422, "Unsupported paper status filter")
        stmt = stmt.where(Paper.status == paper_status)
    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(
        stmt.order_by(Paper.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return {
        "items": [_view(row) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/papers/{paper_id}/file")
def get_paper_file(
    paper_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    try:
        data = private_storage().read(paper.storage_key)
    except Exception:
        raise HTTPException(404, "Stored paper file not found")
    from urllib.parse import quote

    disposition = f"inline; filename*=UTF-8''{quote(paper.file_name)}"
    return Response(
        content=data,
        media_type=paper.content_type,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": disposition,
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.patch("/papers/{paper_id}/assignment")
def assign_paper(
    paper_id: UUID,
    body: StudentAssignmentUpdate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    student_id = body.student_id
    if student_id == paper.student_id:
        return _view(paper)
    _ensure_evidence_mutable(db, paper)
    if student_id:
        student = _org_record(
            db, Student, student_id, membership.organization_id, "Student not found"
        )
        if not student.is_active:
            raise HTTPException(
                422, "An inactive student cannot be assigned to an examination script"
            )
        exam = _org_record(
            db, Exam, paper.exam_id, membership.organization_id, "Examination not found"
        )
        enrollment = db.scalar(
            select(StudentEnrollment).where(
                StudentEnrollment.organization_id == membership.organization_id,
                StudentEnrollment.student_id == student.id,
                StudentEnrollment.class_id == exam.class_id,
                StudentEnrollment.academic_year_id == exam.academic_year_id,
                StudentEnrollment.ended_at.is_(None),
            )
        )
        if not enrollment:
            raise HTTPException(422, "Student is not enrolled in the examination class")
        other = db.scalar(
            select(Paper).where(
                Paper.exam_id == exam.id, Paper.student_id == student.id, Paper.id != paper.id
            )
        )
        if other:
            raise HTTPException(
                409, "Another paper is already assigned to this student for the examination"
            )
    paper.student_id = student_id
    _invalidate_prior_analysis(db, paper, membership.user_id, "Student assignment changed")
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "paper.student_assigned" if student_id else "paper.student_unassigned",
        "paper",
        paper.id,
        {"student_id": str(student_id) if student_id else None},
    )
    db.commit()
    return _view(paper)


@router.get("/papers/{paper_id}/pages")
def list_pages(
    paper_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    rows = db.scalars(
        select(PaperPage)
        .where(
            PaperPage.paper_id == paper.id, PaperPage.organization_id == membership.organization_id
        )
        .order_by(PaperPage.page_number)
    ).all()
    return [
        {
            "id": row.id,
            "paper_id": row.paper_id,
            "source_paper_id": row.source_paper_id,
            "source_page_number": row.source_page_number,
            "rendered_page_number": row.rendered_page_number,
            "page_number": row.page_number,
            "rotation": row.rotation,
            "flagged": row.flagged,
        }
        for row in rows
    ]


@router.get("/papers/{paper_id}/pages/{page_id}/preview")
def preview_page(
    paper_id: UUID,
    page_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    page = db.scalar(
        select(PaperPage).where(
            PaperPage.id == page_id,
            PaperPage.paper_id == paper.id,
            PaperPage.organization_id == membership.organization_id,
        )
    )
    if not page:
        raise HTTPException(404, "Page not found")
    try:
        with private_storage().materialize(paper.storage_key) as scan_path:
            if paper.content_type == "application/pdf":
                with fitz.open(scan_path) as doc:
                    if page.rendered_page_number < 1 or page.rendered_page_number > doc.page_count:
                        raise HTTPException(404, "Source page not found")
                    source = doc.load_page(page.rendered_page_number - 1)
                    source.set_rotation(page.rotation)
                    png = source.get_pixmap(matrix=fitz.Matrix(1.4, 1.4), alpha=False).tobytes(
                        "png"
                    )
            else:
                from PIL import Image

                with Image.open(scan_path) as image:
                    image.load()
                    rotated = image.rotate(-page.rotation, expand=True)
                    if rotated.mode not in ("RGB", "RGBA"):
                        rotated = rotated.convert("RGB")
                    output = io.BytesIO()
                    rotated.save(output, format="PNG", optimize=True)
                    png = output.getvalue()
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, "This paper page could not be rendered")
    return StreamingResponse(
        io.BytesIO(png),
        media_type="image/png",
        headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.put("/papers/{paper_id}/pages/order")
def reorder_pages(
    paper_id: UUID,
    body: PageOrderUpdate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    _ensure_evidence_mutable(db, paper)
    order = body.page_ids
    pages = db.scalars(
        select(PaperPage).where(
            PaperPage.paper_id == paper.id, PaperPage.organization_id == membership.organization_id
        )
    ).all()
    page_ids = {str(page.id) for page in pages}
    if not isinstance(order, list) or len(order) != len(pages) or set(map(str, order)) != page_ids:
        raise HTTPException(422, "Page order must contain each page in this script exactly once")
    by_id = {str(page.id): page for page in pages}
    temporary_start = max((page.page_number for page in pages), default=0) + len(pages) + 1
    for offset, page_id in enumerate(order):
        by_id[str(page_id)].page_number = temporary_start + offset
    db.flush()
    for number, page_id in enumerate(order, start=1):
        by_id[str(page_id)].page_number = number
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "paper.pages_reordered",
        "paper",
        paper.id,
        {"page_count": len(order)},
    )
    db.commit()
    return list_pages(paper_id, membership, db)


@router.patch("/papers/{paper_id}/pages/{page_id}")
def update_page(
    paper_id: UUID,
    page_id: UUID,
    body: PageUpdate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    _ensure_evidence_mutable(db, paper)
    page = db.scalar(
        select(PaperPage).where(
            PaperPage.id == page_id,
            PaperPage.paper_id == paper_id,
            PaperPage.organization_id == membership.organization_id,
        )
    )
    if not page:
        raise HTTPException(404, "Page not found")
    if body.rotation is not None:
        page.rotation = body.rotation
    if body.flagged is not None:
        page.flagged = body.flagged
    _invalidate_prior_analysis(
        db, paper, membership.user_id, "Page orientation, order or review flag changed"
    )
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "paper.page_updated",
        "paper",
        page.paper_id,
        {"page_id": str(page.id), "rotation": page.rotation, "flagged": page.flagged},
    )
    db.commit()
    return {
        "id": page.id,
        "paper_id": page.paper_id,
        "page_number": page.page_number,
        "rotation": page.rotation,
        "flagged": page.flagged,
    }


@router.get("/processing/jobs")
def list_jobs(
    status_filter: str | None = Query(default=None, alias="status"),
    paper_id: UUID | None = None,
    page: int = Query(1, ge=1),
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    stmt = select(ProcessingJob).where(ProcessingJob.organization_id == membership.organization_id)
    if status_filter:
        stmt = stmt.where(ProcessingJob.status == status_filter)
    if paper_id:
        _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
        stmt = stmt.where(ProcessingJob.paper_id == paper_id)
    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(
        stmt.order_by(ProcessingJob.created_at.desc()).offset((page - 1) * 50).limit(50)
    ).all()
    return {
        "items": [
            {
                "id": row.id,
                "paper_id": row.paper_id,
                "task_type": row.task_type,
                "status": row.status,
                "progress": row.progress,
                "error_message": row.error_message,
                "attempts": row.attempts,
                "created_at": row.created_at,
            }
            for row in rows
        ],
        "total": total,
        "page": page,
        "page_size": 50,
    }


@router.get("/papers/{paper_id}/review-data")
def get_review_data(
    paper_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    exam = _org_record(db, Exam, paper.exam_id, membership.organization_id, "Examination not found")
    student = db.get(Student, paper.student_id) if paper.student_id else None
    extraction = db.scalar(
        select(ExtractionResult)
        .where(
            ExtractionResult.paper_id == paper.id,
            ExtractionResult.organization_id == membership.organization_id,
        )
        .order_by(ExtractionResult.created_at.desc())
    )
    rubric = db.scalar(
        select(Rubric)
        .where(Rubric.exam_id == exam.id, Rubric.organization_id == membership.organization_id)
        .order_by(Rubric.version.desc())
    )
    rubric_items = (
        db.scalars(
            select(RubricItem)
            .where(RubricItem.rubric_id == rubric.id)
            .order_by(RubricItem.question_number)
        ).all()
        if rubric
        else []
    )
    grade_rows = db.scalars(
        select(Grade).where(
            Grade.paper_id == paper.id, Grade.organization_id == membership.organization_id
        )
    ).all()
    grades = {
        str(row.rubric_item_id): {
            "ai_score": float(row.ai_score) if row.ai_score is not None else None,
            "ai_confidence": float(row.ai_confidence) if row.ai_confidence is not None else None,
            "ai_warning": row.ai_warning,
            "teacher_score": float(row.teacher_score) if row.teacher_score is not None else None,
            "max_marks": float(row.max_marks),
            "explanation": row.explanation,
            "evidence": row.evidence,
            "correction_reason": row.correction_reason,
            "confirmed_at": row.confirmed_at,
        }
        for row in grade_rows
    }
    pages = db.scalars(
        select(PaperPage)
        .where(
            PaperPage.paper_id == paper.id, PaperPage.organization_id == membership.organization_id
        )
        .order_by(PaperPage.page_number)
    ).all()
    return {
        "paper": _view(paper),
        "exam": {
            "id": exam.id,
            "title": exam.title,
            "max_marks": float(exam.max_marks),
            "class_id": exam.class_id,
            "academic_year_id": exam.academic_year_id,
        },
        "student": {
            "id": student.id,
            "name": f"{student.first_name} {student.last_name}",
            "admission_number": student.admission_number,
        }
        if student
        else None,
        "pages": [
            {
                "id": page.id,
                "source_paper_id": page.source_paper_id,
                "source_page_number": page.source_page_number,
                "rendered_page_number": page.rendered_page_number,
                "page_number": page.page_number,
                "rotation": page.rotation,
                "flagged": page.flagged,
            }
            for page in pages
        ],
        "extraction": {
            "id": extraction.id,
            "answers": extraction.answers,
            "warnings": extraction.warnings,
            "status": extraction.status,
            "provider": extraction.provider,
            "model": extraction.model,
            "created_at": extraction.created_at,
        }
        if extraction
        else None,
        "rubric": {
            "id": rubric.id,
            "version": rubric.version,
            "is_locked": rubric.is_locked,
            "items": [
                {
                    "id": item.id,
                    "question_number": item.question_number,
                    "prompt": item.prompt,
                    "expected_answer": item.expected_answer,
                    "alternatives": item.alternatives,
                    "criteria": item.criteria,
                    "max_marks": float(item.max_marks),
                    "grade": grades.get(str(item.id)),
                }
                for item in rubric_items
            ],
        }
        if rubric
        else None,
    }


@router.put("/papers/{paper_id}/extraction")
def update_extraction(
    paper_id: UUID,
    payload: ExtractionUpdate,
    membership: OrganizationMembership = Depends(
        require_roles(*MANAGERS, "teacher_marker", "reviewer")
    ),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    _ensure_evidence_mutable(db, paper)
    extraction = db.scalar(
        select(ExtractionResult)
        .where(
            ExtractionResult.paper_id == paper.id,
            ExtractionResult.organization_id == membership.organization_id,
        )
        .order_by(ExtractionResult.created_at.desc())
    )
    if not extraction:
        raise HTTPException(409, "Extract answers before editing the transcription")
    page_count = int(
        db.scalar(select(func.count()).select_from(PaperPage).where(PaperPage.paper_id == paper.id))
        or 0
    )
    if any(answer.page_number > page_count for answer in payload.answers):
        raise HTTPException(422, "An answer references a page outside this script")
    extraction.answers = [answer.model_dump() for answer in payload.answers]
    extraction.warnings = payload.warnings
    extraction.status = "needs_review"
    extraction.confirmed_at = None
    paper.status = "needs_review"
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "paper.extraction_corrected",
        "paper",
        paper.id,
        {"answer_count": len(payload.answers), "warning_count": len(payload.warnings)},
    )
    db.commit()
    return {
        "id": extraction.id,
        "status": extraction.status,
        "answers": extraction.answers,
        "warnings": extraction.warnings,
    }


@router.post("/papers/{paper_id}/extraction/confirm")
def confirm_extraction(
    paper_id: UUID,
    membership: OrganizationMembership = Depends(
        require_roles(*MANAGERS, "teacher_marker", "reviewer")
    ),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    _ensure_evidence_mutable(db, paper)
    extraction = db.scalar(
        select(ExtractionResult)
        .where(
            ExtractionResult.paper_id == paper.id,
            ExtractionResult.organization_id == membership.organization_id,
        )
        .order_by(ExtractionResult.created_at.desc())
    )
    if not extraction:
        raise HTTPException(409, "Extract answers before confirming the transcription")
    from datetime import datetime, timezone

    extraction.status = "confirmed"
    extraction.confirmed_at = datetime.now(timezone.utc)
    paper.status = "ready"
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "paper.extraction_confirmed",
        "paper",
        paper.id,
        {"answer_count": len(extraction.answers)},
    )
    db.commit()
    return {
        "id": extraction.id,
        "status": extraction.status,
        "confirmed_at": extraction.confirmed_at,
    }


@router.get("/papers/{paper_id}/grading")
def get_grading(
    paper_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    return get_review_data(paper_id, membership, db)


@router.post("/papers/{paper_id}/grade", status_code=202)
def queue_grading(
    paper_id: UUID,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    scoped_key = _scoped_job_key(membership.organization_id, paper.id, "grade", idempotency_key)
    existing = _existing_job(db, paper.id, "grade", scoped_key)
    if existing:
        return _job_view(existing)
    if not settings.vision_ready:
        raise HTTPException(
            503,
            "Vision provider is not configured. Set GRADEFLOW_VISION_BASE_URL, GRADEFLOW_VISION_MODEL and GRADEFLOW_VISION_API_KEY.",
        )
    if not paper.student_id:
        raise HTTPException(409, "Assign the script to a student before grading")
    extraction = db.scalar(
        select(ExtractionResult)
        .where(ExtractionResult.paper_id == paper.id, ExtractionResult.status == "confirmed")
        .order_by(ExtractionResult.created_at.desc())
    )
    rubric = db.scalar(
        select(Rubric)
        .where(
            Rubric.exam_id == paper.exam_id, Rubric.organization_id == membership.organization_id
        )
        .order_by(Rubric.version.desc())
    )
    if not extraction or not rubric:
        raise HTTPException(
            409, "Confirm the extracted answers and save a marking scheme before grading"
        )
    rubric.is_locked = True
    job = ProcessingJob(
        organization_id=membership.organization_id,
        paper_id=paper.id,
        task_type="grade",
        rubric_id=rubric.id,
        status="queued",
        progress=0,
        idempotency_key=scoped_key,
    )
    job, created = _reserve_job(db, paper, job, scoped_key)
    if created:
        try:
            from app.tasks import grade_paper

            grade_paper.delay(str(job.id))
        except Exception:
            job.status = "failed"
            job.error_message = (
                "The processing worker is unavailable. Start the Celery worker and retry."
            )
            paper.status = "failed"
            db.commit()
    return _job_view(job)


@router.post("/papers/{paper_id}/extract", status_code=202)
def queue_extraction(
    paper_id: UUID,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    paper = _org_record(db, Paper, paper_id, membership.organization_id, "Paper not found")
    scoped_key = _scoped_job_key(membership.organization_id, paper.id, "extract", idempotency_key)
    existing = _existing_job(db, paper.id, "extract", scoped_key)
    if existing:
        return _job_view(existing)
    _ensure_evidence_mutable(db, paper)
    if not settings.vision_ready:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "Vision provider is not configured. Set GRADEFLOW_VISION_BASE_URL, GRADEFLOW_VISION_MODEL and GRADEFLOW_VISION_API_KEY.",
        )
    job = ProcessingJob(
        organization_id=membership.organization_id,
        paper_id=paper.id,
        task_type="extract",
        status="queued",
        progress=0,
        attempts=0,
        idempotency_key=scoped_key,
    )
    job, created = _reserve_job(db, paper, job, scoped_key)
    if created:
        try:
            from app.tasks import extract_paper

            extract_paper.delay(str(job.id))
        except Exception:
            job.status = "failed"
            job.error_message = (
                "The processing worker is unavailable. Start the Celery worker and retry."
            )
            paper.status = "failed"
            db.commit()
    return _job_view(job)


@router.post("/processing/jobs/{job_id}/retry", status_code=202)
def retry_job(
    job_id: UUID,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    job = _org_record(db, ProcessingJob, job_id, membership.organization_id, "Job not found")
    paper = _org_record(db, Paper, job.paper_id, membership.organization_id, "Paper not found")
    active = _active_job(db, paper.id)
    if active and active.id != job.id:
        if active.task_type == job.task_type:
            return _job_view(active)
        raise HTTPException(409, f"A {active.task_type} job is already active for this script")
    if job.status != "failed" or job.attempts >= 3:
        raise HTTPException(409, "Only failed jobs with fewer than three attempts can be retried")
    if not settings.vision_ready:
        raise HTTPException(503, "Vision provider is not configured")
    if job.task_type not in {"extract", "grade"}:
        raise HTTPException(409, "This job type cannot be retried through the examination worker")
    if job.task_type == "grade":
        latest_rubric = db.scalar(
            select(Rubric)
            .where(Rubric.exam_id == paper.exam_id)
            .order_by(Rubric.version.desc())
        )
        if not latest_rubric:
            raise HTTPException(409, "Save a marking scheme before retrying this grading job")
        if job.rubric_id and job.rubric_id != latest_rubric.id:
            raise HTTPException(409, "This job used an older rubric; queue a new grading job")
        job.rubric_id = latest_rubric.id
        latest_rubric.is_locked = True
    job.status = "queued"
    job.progress = 0
    job.error_message = None
    paper.status = "queued"
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        active = _active_job(db, paper.id)
        if active:
            if active.task_type == job.task_type:
                return _job_view(active)
            raise HTTPException(409, f"A {active.task_type} job is already active for this script")
        raise
    try:
        from app.tasks import extract_paper, grade_paper

        (grade_paper if job.task_type == "grade" else extract_paper).delay(str(job.id))
    except Exception:
        job.status = "failed"
        job.error_message = (
            "The processing worker is unavailable. Start the Celery worker and retry."
        )
        paper.status = "failed"
        db.commit()
    return {
        **_job_view(job),
        "attempts": job.attempts,
    }
