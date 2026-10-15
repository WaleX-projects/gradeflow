import csv
import io
from pathlib import Path
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import StreamingResponse
from openpyxl import Workbook
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_membership, require_roles
from app.database import get_db
from app.models import (
    AcademicYear,
    AuditEvent,
    Exam,
    ExamResult,
    ExtractionResult,
    Grade,
    GradingRun,
    Organization,
    OrganizationMembership,
    Paper,
    ProcessingJob,
    Rubric,
    RubricItem,
    SchoolClass,
    Student,
    StudentEnrollment,
    StudentImportBatch,
    Subject,
    Term,
)
from app.schemas.contracts import (
    AcademicYearCreate,
    ExamCreate,
    ExamStatusUpdate,
    ExamView,
    GradeConfirm,
    OrganizationUpdate,
    RubricSave,
    SimpleAcademicCreate,
    StudentCreate,
    StudentEnrollmentCreate,
    StudentUpdate,
    TermCreate,
)
from app.services.audit import record_audit as _audit

router = APIRouter(tags=["school workspace"])
MANAGERS = ("owner", "school_admin", "exam_officer")
MARKERS = (*MANAGERS, "teacher_marker", "reviewer")


def _org_row(db: Session, model, row_id: UUID, org_id: UUID, message: str):
    row = db.scalar(select(model).where(model.id == row_id, model.organization_id == org_id))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, message)
    return row


def _student_json(db: Session, row: Student, org_id: UUID):
    enrollment = db.scalar(
        select(StudentEnrollment)
        .where(
            StudentEnrollment.student_id == row.id,
            StudentEnrollment.organization_id == org_id,
            StudentEnrollment.ended_at.is_(None),
        )
        .order_by(StudentEnrollment.started_at.desc())
    )
    klass = db.get(SchoolClass, enrollment.class_id) if enrollment else None
    return {
        "id": row.id,
        "admission_number": row.admission_number,
        "first_name": row.first_name,
        "last_name": row.last_name,
        "is_active": row.is_active,
        "class_name": klass.name if klass else None,
    }


@router.get("/dashboard")
def dashboard(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    org = membership.organization_id

    def count(model, *criteria):
        return int(
            db.scalar(
                select(func.count())
                .select_from(model)
                .where(model.organization_id == org, *criteria)
            )
            or 0
        )

    active_exams = count(Exam, Exam.status.in_(["active", "in_progress", "review"]))
    papers = count(Paper)
    pending = count(Paper, Paper.status.in_(["uploaded", "needs_review", "review"]))
    completed_jobs = count(
        ProcessingJob, ProcessingJob.status == "completed", ProcessingJob.task_type == "grade"
    )
    recent_audit = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.organization_id == org)
        .order_by(AuditEvent.created_at.desc())
        .limit(8)
    ).all()
    recent = [
        {
            "id": str(a.id),
            "action": a.action,
            "entity_type": a.entity_type,
            "created_at": a.created_at.isoformat(),
        }
        for a in recent_audit
    ]
    failures = count(ProcessingJob, ProcessingJob.status == "failed")
    return {
        "students": count(Student, Student.is_active.is_(True)),
        "active_exams": active_exams,
        "papers_uploaded": papers,
        "papers_awaiting_review": pending,
        "completed_jobs": completed_jobs,
        "processing_failures": int(failures),
        "recent_activity": recent,
        "organization_name": db.get(Organization, org).name,
    }


@router.get("/organization")
def get_organization(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    organization = db.get(Organization, membership.organization_id)
    return {"id": organization.id, "name": organization.name, "role": membership.role}


@router.patch("/organization")
def update_organization(
    payload: OrganizationUpdate,
    membership: OrganizationMembership = Depends(require_roles("owner", "school_admin")),
    db: Session = Depends(get_db),
):
    organization = db.get(Organization, membership.organization_id)
    organization.name = payload.name.strip()
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "organization.updated",
        "organization",
        organization.id,
    )
    db.commit()
    return {"id": organization.id, "name": organization.name, "role": membership.role}


@router.get("/academics/years")
def list_years(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(AcademicYear)
        .where(AcademicYear.organization_id == membership.organization_id)
        .order_by(AcademicYear.label.desc())
    ).all()
    return [
        {
            "id": r.id,
            "label": r.label,
            "starts_on": r.starts_on,
            "ends_on": r.ends_on,
            "is_current": r.is_current,
        }
        for r in rows
    ]


@router.post("/academics/years", status_code=201)
def create_year(
    payload: AcademicYearCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    if payload.starts_on and payload.ends_on and payload.ends_on < payload.starts_on:
        raise HTTPException(422, "Academic year end must be on or after its start")
    if db.scalar(
        select(AcademicYear).where(
            AcademicYear.organization_id == membership.organization_id,
            AcademicYear.label == payload.label,
        )
    ):
        raise HTTPException(409, "That academic year already exists")
    if payload.is_current:
        db.query(AcademicYear).filter(
            AcademicYear.organization_id == membership.organization_id
        ).update({AcademicYear.is_current: False})
    row = AcademicYear(organization_id=membership.organization_id, **payload.model_dump())
    db.add(row)
    db.flush()
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "academic_year.created",
        "academic_year",
        row.id,
    )
    db.commit()
    return {
        "id": row.id,
        "label": row.label,
        "starts_on": row.starts_on,
        "ends_on": row.ends_on,
        "is_current": row.is_current,
    }


@router.get("/academics/terms")
def list_terms(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Term).where(Term.organization_id == membership.organization_id).order_by(Term.name)
    ).all()
    return [{"id": r.id, "name": r.name, "academic_year_id": r.academic_year_id} for r in rows]


@router.post("/academics/terms", status_code=201)
def create_term(
    payload: TermCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    _org_row(
        db,
        AcademicYear,
        payload.academic_year_id,
        membership.organization_id,
        "Academic year not found",
    )
    if db.scalar(
        select(Term).where(
            Term.organization_id == membership.organization_id,
            Term.academic_year_id == payload.academic_year_id,
            Term.name == payload.name,
        )
    ):
        raise HTTPException(409, "That term already exists for this year")
    row = Term(organization_id=membership.organization_id, **payload.model_dump())
    db.add(row)
    db.flush()
    _audit(db, membership.organization_id, membership.user_id, "term.created", "term", row.id)
    db.commit()
    return {"id": row.id, "name": row.name, "academic_year_id": row.academic_year_id}


@router.get("/academics/classes")
def list_classes(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    return [
        {"id": r.id, "name": r.name}
        for r in db.scalars(
            select(SchoolClass)
            .where(SchoolClass.organization_id == membership.organization_id)
            .order_by(SchoolClass.name)
        ).all()
    ]


@router.post("/academics/classes", status_code=201)
def create_class(
    payload: SimpleAcademicCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    if db.scalar(
        select(SchoolClass).where(
            SchoolClass.organization_id == membership.organization_id,
            SchoolClass.name == payload.name.strip(),
        )
    ):
        raise HTTPException(409, "That class already exists")
    row = SchoolClass(organization_id=membership.organization_id, name=payload.name.strip())
    db.add(row)
    db.flush()
    _audit(db, membership.organization_id, membership.user_id, "class.created", "class", row.id)
    db.commit()
    return {"id": row.id, "name": row.name}


@router.get("/academics/subjects")
def list_subjects(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    return [
        {"id": r.id, "name": r.name, "code": r.code}
        for r in db.scalars(
            select(Subject)
            .where(Subject.organization_id == membership.organization_id)
            .order_by(Subject.name)
        ).all()
    ]


@router.post("/academics/subjects", status_code=201)
def create_subject(
    payload: SimpleAcademicCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    if db.scalar(
        select(Subject).where(
            Subject.organization_id == membership.organization_id,
            Subject.name == payload.name.strip(),
        )
    ):
        raise HTTPException(409, "That subject already exists")
    row = Subject(organization_id=membership.organization_id, name=payload.name.strip())
    db.add(row)
    db.flush()
    _audit(db, membership.organization_id, membership.user_id, "subject.created", "subject", row.id)
    db.commit()
    return {"id": row.id, "name": row.name, "code": row.code}


@router.get("/students")
def list_students(
    search: str = "",
    class_id: UUID | None = None,
    academic_year_id: UUID | None = None,
    is_active: bool | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    stmt = select(Student).where(Student.organization_id == membership.organization_id)
    if search.strip():
        term = f"%{search.strip()}%"
        stmt = stmt.where(
            (Student.first_name.ilike(term))
            | (Student.last_name.ilike(term))
            | (Student.admission_number.ilike(term))
        )
    if is_active is not None:
        stmt = stmt.where(Student.is_active.is_(is_active))
    if class_id:
        _org_row(db, SchoolClass, class_id, membership.organization_id, "Class not found")
        enrollment = select(StudentEnrollment.id).where(
            StudentEnrollment.organization_id == membership.organization_id,
            StudentEnrollment.student_id == Student.id,
            StudentEnrollment.class_id == class_id,
            StudentEnrollment.ended_at.is_(None),
        )
        if academic_year_id:
            _org_row(
                db,
                AcademicYear,
                academic_year_id,
                membership.organization_id,
                "Academic year not found",
            )
            enrollment = enrollment.where(StudentEnrollment.academic_year_id == academic_year_id)
        stmt = stmt.where(enrollment.exists())
    elif academic_year_id:
        _org_row(
            db,
            AcademicYear,
            academic_year_id,
            membership.organization_id,
            "Academic year not found",
        )
        stmt = stmt.where(
            select(StudentEnrollment.id)
            .where(
                StudentEnrollment.organization_id == membership.organization_id,
                StudentEnrollment.student_id == Student.id,
                StudentEnrollment.academic_year_id == academic_year_id,
                StudentEnrollment.ended_at.is_(None),
            )
            .exists()
        )
    total = int(db.scalar(select(func.count()).select_from(stmt.subquery())) or 0)
    rows = db.scalars(
        stmt.order_by(Student.last_name, Student.first_name)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return {
        "items": [_student_json(db, r, membership.organization_id) for r in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/students", status_code=201)
def create_student(
    payload: StudentCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    if db.scalar(
        select(Student).where(
            Student.organization_id == org,
            Student.admission_number == payload.admission_number.strip(),
        )
    ):
        raise HTTPException(409, "That admission number already exists")
    row = Student(
        organization_id=org,
        admission_number=payload.admission_number.strip(),
        first_name=payload.first_name.strip(),
        last_name=payload.last_name.strip(),
    )
    db.add(row)
    db.flush()
    if payload.class_id or payload.academic_year_id:
        if not payload.class_id or not payload.academic_year_id:
            raise HTTPException(422, "Class and academic year must be provided together")
        _org_row(db, SchoolClass, payload.class_id, org, "Class not found")
        _org_row(db, AcademicYear, payload.academic_year_id, org, "Academic year not found")
        db.add(
            StudentEnrollment(
                organization_id=org,
                student_id=row.id,
                class_id=payload.class_id,
                academic_year_id=payload.academic_year_id,
            )
        )
    _audit(db, org, membership.user_id, "student.created", "student", row.id)
    db.commit()
    return _student_json(db, row, org)


@router.patch("/students/{student_id}")
def update_student(
    student_id: UUID,
    payload: StudentUpdate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    row = _org_row(db, Student, student_id, membership.organization_id, "Student not found")
    duplicate = db.scalar(
        select(Student).where(
            Student.organization_id == membership.organization_id,
            Student.admission_number == payload.admission_number.strip(),
            Student.id != row.id,
        )
    )
    if duplicate:
        raise HTTPException(409, "That admission number already exists")
    for key, value in payload.model_dump().items():
        setattr(row, key, value.strip() if isinstance(value, str) else value)
    _audit(db, membership.organization_id, membership.user_id, "student.updated", "student", row.id)
    db.commit()
    return _student_json(db, row, membership.organization_id)


@router.get("/students/{student_id}")
def student_profile(
    student_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    student = _org_row(db, Student, student_id, org, "Student not found")
    enrollments = db.execute(
        select(StudentEnrollment, SchoolClass, AcademicYear)
        .join(SchoolClass, SchoolClass.id == StudentEnrollment.class_id)
        .join(AcademicYear, AcademicYear.id == StudentEnrollment.academic_year_id)
        .where(StudentEnrollment.organization_id == org, StudentEnrollment.student_id == student.id)
        .order_by(StudentEnrollment.started_at.desc())
    ).all()
    results_rows = db.execute(
        select(ExamResult, Exam)
        .join(Exam, Exam.id == ExamResult.exam_id)
        .where(ExamResult.organization_id == org, ExamResult.student_id == student.id)
        .order_by(ExamResult.updated_at.desc())
    ).all()
    papers = db.execute(
        select(Paper, Exam)
        .join(Exam, Exam.id == Paper.exam_id)
        .where(Paper.organization_id == org, Paper.student_id == student.id)
        .order_by(Paper.created_at.desc())
        .limit(50)
    ).all()
    return {
        "student": {
            "id": student.id,
            "admission_number": student.admission_number,
            "first_name": student.first_name,
            "last_name": student.last_name,
            "is_active": student.is_active,
            "created_at": student.created_at,
        },
        "enrollments": [
            {
                "id": enrollment.id,
                "class_id": klass.id,
                "class_name": klass.name,
                "academic_year_id": year.id,
                "academic_year": year.label,
                "started_at": enrollment.started_at,
                "ended_at": enrollment.ended_at,
            }
            for enrollment, klass, year in enrollments
        ],
        "exam_history": [
            {
                "exam_id": exam.id,
                "title": exam.title,
                "status": result.status,
                "score": float(result.total_score),
                "max_marks": float(result.max_marks),
                "updated_at": result.updated_at,
            }
            for result, exam in results_rows
        ],
        "papers": [
            {
                "id": paper.id,
                "exam_id": exam.id,
                "exam_title": exam.title,
                "status": paper.status,
                "created_at": paper.created_at,
            }
            for paper, exam in papers
        ],
    }


@router.post("/students/{student_id}/enrollments", status_code=201)
def add_enrollment(
    student_id: UUID,
    body: StudentEnrollmentCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    student = _org_row(db, Student, student_id, org, "Student not found")
    class_uuid, year_uuid = body.class_id, body.academic_year_id
    _org_row(db, SchoolClass, class_uuid, org, "Class not found")
    _org_row(db, AcademicYear, year_uuid, org, "Academic year not found")
    exists = db.scalar(
        select(StudentEnrollment.id).where(
            StudentEnrollment.organization_id == org,
            StudentEnrollment.student_id == student.id,
            StudentEnrollment.class_id == class_uuid,
            StudentEnrollment.academic_year_id == year_uuid,
        )
    )
    if exists:
        raise HTTPException(
            409, "An enrollment record already exists for this class and academic year"
        )
    row = StudentEnrollment(
        organization_id=org, student_id=student.id, class_id=class_uuid, academic_year_id=year_uuid
    )
    db.add(row)
    db.flush()
    _audit(db, org, membership.user_id, "student.enrolled", "enrollment", row.id)
    db.commit()
    return {
        "id": row.id,
        "student_id": row.student_id,
        "class_id": row.class_id,
        "academic_year_id": row.academic_year_id,
        "started_at": row.started_at,
        "ended_at": row.ended_at,
    }


@router.post("/students/{student_id}/enrollments/{enrollment_id}/close")
def close_enrollment(
    student_id: UUID,
    enrollment_id: UUID,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    _org_row(db, Student, student_id, membership.organization_id, "Student not found")
    row = db.scalar(
        select(StudentEnrollment).where(
            StudentEnrollment.id == enrollment_id,
            StudentEnrollment.student_id == student_id,
            StudentEnrollment.organization_id == membership.organization_id,
        )
    )
    if not row:
        raise HTTPException(404, "Enrollment not found")
    if row.ended_at is None:
        row.ended_at = datetime.now(timezone.utc)
        _audit(
            db,
            membership.organization_id,
            membership.user_id,
            "student.enrollment_closed",
            "enrollment",
            row.id,
        )
        db.commit()
    return {"id": row.id, "ended_at": row.ended_at}


@router.post("/students/import.csv", status_code=201)
async def import_students(
    file: UploadFile = File(...),
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    name = Path(file.filename or "students.csv").name[:255]
    if Path(name).suffix.lower() != ".csv":
        raise HTTPException(415, "Choose a .csv file")
    raw = await file.read(5 * 1024 * 1024 + 1)
    await file.close()
    if not raw or len(raw) > 5 * 1024 * 1024:
        raise HTTPException(413, "Student CSV must be between 1 byte and 5 MB")
    try:
        text = raw.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text))
        headers = {str(col or "").strip().lower() for col in (reader.fieldnames or [])}
        required = {"admission_number", "first_name", "last_name"}
        if not required.issubset(headers):
            raise HTTPException(
                422, "CSV must include admission_number, first_name and last_name columns"
            )
        source_rows = list(reader)
    except UnicodeDecodeError:
        raise HTTPException(422, "Save the CSV as UTF-8 and try again")
    if len(source_rows) > 5000:
        raise HTTPException(413, "A single import can contain at most 5,000 student rows")
    org = membership.organization_id
    batch = StudentImportBatch(
        organization_id=org,
        created_by=membership.user_id,
        file_name=name,
        status="processing",
        total_rows=len(source_rows),
    )
    db.add(batch)
    db.flush()
    existing = {
        str(value).strip().casefold()
        for value in db.scalars(
            select(Student.admission_number).where(Student.organization_id == org)
        ).all()
    }
    seen: set[str] = set()
    errors: list[dict] = []
    imported = 0
    class_rows = db.scalars(select(SchoolClass).where(SchoolClass.organization_id == org)).all()
    year_rows = db.scalars(select(AcademicYear).where(AcademicYear.organization_id == org)).all()
    classes = {row.name.casefold(): row for row in class_rows}
    years = {row.label.casefold(): row for row in year_rows}
    for line, source in enumerate(source_rows, start=2):
        normalized = {
            str(key or "").strip().lower(): str(value or "").strip()
            for key, value in source.items()
        }
        admission = normalized.get("admission_number", "")
        first_name = normalized.get("first_name", "")
        last_name = normalized.get("last_name", "")
        issues = []
        if not admission or len(admission) > 60:
            issues.append(
                {"field": "admission_number", "message": "Required; maximum 60 characters"}
            )
        if not first_name or len(first_name) > 80:
            issues.append({"field": "first_name", "message": "Required; maximum 80 characters"})
        if not last_name or len(last_name) > 80:
            issues.append({"field": "last_name", "message": "Required; maximum 80 characters"})
        key = admission.casefold()
        if key and (key in existing or key in seen):
            issues.append(
                {"field": "admission_number", "message": "Admission number already exists"}
            )
        class_name = normalized.get("class_name", "").casefold()
        year_label = normalized.get("academic_year", "").casefold()
        klass = classes.get(class_name) if class_name else None
        year = years.get(year_label) if year_label else None
        if bool(class_name) != bool(year_label):
            issues.append(
                {"field": "class_name", "message": "Provide class_name and academic_year together"}
            )
        elif class_name and (not klass or not year):
            issues.append(
                {
                    "field": "class_name",
                    "message": "Class or academic year was not found in this school",
                }
            )
        if issues:
            errors.append({"row": line, "issues": issues})
            continue
        try:
            with db.begin_nested():
                student = Student(
                    organization_id=org,
                    admission_number=admission,
                    first_name=first_name,
                    last_name=last_name,
                )
                db.add(student)
                db.flush()
                if klass and year:
                    db.add(
                        StudentEnrollment(
                            organization_id=org,
                            student_id=student.id,
                            class_id=klass.id,
                            academic_year_id=year.id,
                        )
                    )
                    db.flush()
            existing.add(key)
            seen.add(key)
            imported += 1
        except IntegrityError:
            errors.append(
                {
                    "row": line,
                    "issues": [
                        {
                            "field": "admission_number",
                            "message": "Admission number conflicts with another record",
                        }
                    ],
                }
            )
    batch.total_rows = len(source_rows)
    batch.imported_rows = imported
    batch.errors = errors
    batch.status = "completed" if not errors else ("partial" if imported else "failed")
    _audit(
        db,
        org,
        membership.user_id,
        "students.csv_imported",
        "student_import_batch",
        batch.id,
        {"imported": imported, "failed_rows": len(errors)},
    )
    db.commit()
    return {
        "id": batch.id,
        "file_name": batch.file_name,
        "total_rows": batch.total_rows,
        "imported_rows": batch.imported_rows,
        "failed_rows": len(errors),
        "status": batch.status,
        "errors": errors,
    }


@router.get("/students/import-batches")
def student_import_history(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(StudentImportBatch)
        .where(StudentImportBatch.organization_id == membership.organization_id)
        .order_by(StudentImportBatch.created_at.desc())
        .limit(100)
    ).all()
    return [
        {
            "id": row.id,
            "file_name": row.file_name,
            "status": row.status,
            "total_rows": row.total_rows,
            "imported_rows": row.imported_rows,
            "failed_rows": len(row.errors),
            "created_at": row.created_at,
        }
        for row in rows
    ]


@router.get("/exams")
def list_exams(
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Exam)
        .where(Exam.organization_id == membership.organization_id)
        .order_by(Exam.created_at.desc())
    ).all()
    counts = dict(
        db.execute(
            select(Paper.exam_id, func.count(Paper.id))
            .where(Paper.organization_id == membership.organization_id, Paper.status != "organized")
            .group_by(Paper.exam_id)
        ).all()
    )
    return [
        {
            "id": r.id,
            "title": r.title,
            "class_id": r.class_id,
            "subject_id": r.subject_id,
            "academic_year_id": r.academic_year_id,
            "term_id": r.term_id,
            "exam_type": r.exam_type,
            "max_marks": float(r.max_marks),
            "scheduled_on": r.scheduled_on,
            "status": r.status,
            "paper_count": int(counts.get(r.id, 0)),
            "created_at": r.created_at,
        }
        for r in rows
    ]


@router.get("/exams/{exam_id}")
def get_exam(
    exam_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    row = _org_row(db, Exam, exam_id, membership.organization_id, "Exam not found")
    paper_rows = db.scalars(
        select(Paper)
        .where(Paper.organization_id == membership.organization_id, Paper.exam_id == row.id)
        .order_by(Paper.created_at.desc())
        .limit(200)
    ).all()
    return {
        "id": row.id,
        "title": row.title,
        "class_id": row.class_id,
        "subject_id": row.subject_id,
        "academic_year_id": row.academic_year_id,
        "term_id": row.term_id,
        "exam_type": row.exam_type,
        "max_marks": float(row.max_marks),
        "scheduled_on": row.scheduled_on,
        "status": row.status,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "papers": [
            {
                "id": paper.id,
                "file_name": paper.file_name,
                "student_id": paper.student_id,
                "status": paper.status,
                "created_at": paper.created_at,
            }
            for paper in paper_rows
        ],
    }


@router.post("/exams", status_code=201, response_model=ExamView)
def create_exam(
    payload: ExamCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    for model, record_id, name in [
        (SchoolClass, payload.class_id, "Class"),
        (Subject, payload.subject_id, "Subject"),
        (AcademicYear, payload.academic_year_id, "Academic year"),
        (Term, payload.term_id, "Term"),
    ]:
        _org_row(db, model, record_id, org, f"{name} not found")
    term = db.get(Term, payload.term_id)
    if term.academic_year_id != payload.academic_year_id:
        raise HTTPException(422, "Selected term does not belong to the selected academic year")
    row = Exam(organization_id=org, **payload.model_dump(), status="draft")
    db.add(row)
    db.flush()
    _audit(db, org, membership.user_id, "exam.created", "exam", row.id)
    db.commit()
    db.refresh(row)
    return ExamView(
        id=row.id,
        title=row.title,
        class_id=row.class_id,
        subject_id=row.subject_id,
        academic_year_id=row.academic_year_id,
        term_id=row.term_id,
        exam_type=row.exam_type,
        max_marks=float(row.max_marks),
        scheduled_on=row.scheduled_on,
        status=row.status,
        created_at=row.created_at,
    )


@router.put("/exams/{exam_id}")
def edit_exam(
    exam_id: UUID,
    payload: ExamCreate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    row = _org_row(db, Exam, exam_id, org, "Exam not found")
    if db.scalar(
        select(GradingRun.id)
        .where(
            GradingRun.paper_id.in_(select(Paper.id).where(Paper.exam_id == row.id)),
            GradingRun.status.in_(["processing", "completed"]),
        )
        .limit(1)
    ):
        raise HTTPException(
            409, "Exam details are locked after grading starts; create a new examination instead"
        )
    for model, record_id, name in [
        (SchoolClass, payload.class_id, "Class"),
        (Subject, payload.subject_id, "Subject"),
        (AcademicYear, payload.academic_year_id, "Academic year"),
        (Term, payload.term_id, "Term"),
    ]:
        _org_row(db, model, record_id, org, f"{name} not found")
    term = _org_row(db, Term, payload.term_id, org, "Term not found")
    if term.academic_year_id != payload.academic_year_id:
        raise HTTPException(422, "Selected term does not belong to the selected academic year")
    for key, value in payload.model_dump().items():
        setattr(row, key, value)
    row.updated_at = datetime.now(timezone.utc)
    _audit(db, org, membership.user_id, "exam.updated", "exam", row.id)
    db.commit()
    return get_exam(row.id, membership, db)


@router.patch("/exams/{exam_id}/status")
def update_exam_status(
    exam_id: UUID,
    body: ExamStatusUpdate,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    row = _org_row(db, Exam, exam_id, membership.organization_id, "Exam not found")
    new_status = body.status
    allowed_transitions = {
        "draft": {"active", "archived"},
        "active": {"in_progress", "review", "archived"},
        "in_progress": {"review", "completed"},
        "review": {"in_progress", "completed"},
        "completed": {"published", "archived"},
        "published": {"completed", "archived"},
        "archived": set(),
    }
    if new_status != row.status and new_status not in allowed_transitions.get(row.status, set()):
        raise HTTPException(
            409, f"Cannot change examination status from {row.status} to {new_status}"
        )
    if new_status == "published":
        if not db.scalar(
            select(ExamResult).where(ExamResult.exam_id == row.id, ExamResult.status == "finalized")
        ):
            raise HTTPException(409, "Finalize at least one result before publishing")
    row.status = new_status
    row.updated_at = datetime.now(timezone.utc)
    _audit(
        db,
        membership.organization_id,
        membership.user_id,
        "exam.status_changed",
        "exam",
        row.id,
        {"status": new_status},
    )
    db.commit()
    return {"id": row.id, "status": row.status}


@router.get("/exams/{exam_id}/rubric")
def get_rubric(
    exam_id: UUID,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    exam = _org_row(db, Exam, exam_id, membership.organization_id, "Exam not found")
    rubric = db.scalar(
        select(Rubric).where(Rubric.exam_id == exam.id).order_by(Rubric.version.desc())
    )
    if not rubric:
        return {"rubric": None, "exam_max_marks": float(exam.max_marks)}
    items = db.scalars(
        select(RubricItem)
        .where(RubricItem.rubric_id == rubric.id)
        .order_by(RubricItem.question_number)
    ).all()
    return {
        "rubric": {
            "id": rubric.id,
            "exam_id": rubric.exam_id,
            "version": rubric.version,
            "is_locked": rubric.is_locked,
            "items": [
                {
                    "id": i.id,
                    "question_number": i.question_number,
                    "prompt": i.prompt,
                    "expected_answer": i.expected_answer,
                    "alternatives": i.alternatives,
                    "criteria": i.criteria,
                    "max_marks": float(i.max_marks),
                }
                for i in items
            ],
        },
        "exam_max_marks": float(exam.max_marks),
    }


@router.put("/exams/{exam_id}/rubric")
def save_rubric(
    exam_id: UUID,
    payload: RubricSave,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS, "teacher_marker")),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    exam = _org_row(db, Exam, exam_id, org, "Exam not found")
    total = sum(Decimal(str(item.max_marks)) for item in payload.items)
    if total != Decimal(str(exam.max_marks)):
        raise HTTPException(
            422, f"Rubric questions total {total} marks; exam maximum is {exam.max_marks}"
        )
    latest = db.scalar(
        select(Rubric).where(Rubric.exam_id == exam.id).order_by(Rubric.version.desc())
    )
    active_job = db.scalar(
        select(ProcessingJob.id)
        .join(Paper, Paper.id == ProcessingJob.paper_id)
        .where(
            Paper.exam_id == exam.id,
            ProcessingJob.task_type == "grade",
            ProcessingJob.status.in_(["queued", "processing"]),
        )
        .limit(1)
    )
    if active_job:
        raise HTTPException(409, "Wait for active grading jobs before changing the rubric")
    created_version = False
    if latest:
        has_started = bool(
            db.scalar(select(GradingRun.id).where(GradingRun.rubric_id == latest.id).limit(1))
        )
        if latest.is_locked or has_started:
            latest.is_locked = True
            rubric = Rubric(organization_id=org, exam_id=exam.id, version=latest.version + 1)
            db.add(rubric)
            db.flush()
            created_version = True
        else:
            db.execute(delete(RubricItem).where(RubricItem.rubric_id == latest.id))
            rubric = latest
    else:
        rubric = Rubric(organization_id=org, exam_id=exam.id, version=1)
        db.add(rubric)
        db.flush()
        created_version = True
    for item in payload.items:
        db.add(RubricItem(rubric_id=rubric.id, **item.model_dump()))
    _audit(
        db,
        org,
        membership.user_id,
        "rubric.saved",
        "rubric",
        rubric.id,
        {"version": rubric.version, "item_count": len(payload.items)},
    )
    if created_version:
        prior_results = db.scalars(
            select(ExamResult).where(
                ExamResult.exam_id == exam.id,
                ExamResult.organization_id == org,
                ExamResult.status.in_(["finalized", "published"]),
            )
        ).all()
        for result in prior_results:
            previous_status = result.status
            result.status = "draft"
            result.published_at = None
            result.updated_at = datetime.now(timezone.utc)
            _audit(
                db,
                org,
                membership.user_id,
                "exam_result.invalidated_by_rubric_revision",
                "exam_result",
                result.id,
                {"previous_status": previous_status, "rubric_version": rubric.version},
            )
    db.commit()
    return {
        "id": rubric.id,
        "exam_id": exam.id,
        "version": rubric.version,
        "is_locked": rubric.is_locked,
        "total_marks": float(total),
    }


@router.post("/papers/{paper_id}/grades/confirm", status_code=200)
def confirm_grade(
    paper_id: UUID,
    payload: GradeConfirm,
    membership: OrganizationMembership = Depends(require_roles(*MARKERS)),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    paper = _org_row(db, Paper, paper_id, org, "Paper not found")
    rubric_item = db.get(RubricItem, payload.rubric_item_id)
    if not rubric_item:
        raise HTTPException(404, "Rubric question not found")
    rubric = db.scalar(
        select(Rubric)
        .where(Rubric.exam_id == paper.exam_id, Rubric.organization_id == org)
        .order_by(Rubric.version.desc())
    )
    if not rubric or rubric_item.rubric_id != rubric.id:
        raise HTTPException(404, "Rubric question not found for this examination")
    extraction = db.scalar(
        select(ExtractionResult)
        .where(
            ExtractionResult.paper_id == paper.id,
            ExtractionResult.organization_id == org,
            ExtractionResult.status == "confirmed",
        )
        .order_by(ExtractionResult.created_at.desc())
    )
    if not extraction:
        raise HTTPException(409, "A teacher must confirm the transcription before marks are approved")
    if payload.score > float(rubric_item.max_marks):
        raise HTTPException(422, f"Score must be between 0 and {rubric_item.max_marks}")
    if payload.score < 0:
        raise HTTPException(422, "Score cannot be negative")
    if paper.student_id is None:
        raise HTTPException(409, "Assign this paper to a student before confirming marks")
    row = db.scalar(
        select(Grade).where(Grade.paper_id == paper.id, Grade.rubric_item_id == rubric_item.id)
    )
    if not row:
        row = Grade(
            organization_id=org,
            paper_id=paper.id,
            rubric_item_id=rubric_item.id,
            max_marks=rubric_item.max_marks,
        )
        db.add(row)
    previous_score = float(row.teacher_score) if row.teacher_score is not None else None
    previous_confirmed_at = row.confirmed_at.isoformat() if row.confirmed_at else None
    if (
        previous_score is not None
        and previous_score != payload.score
        and not (payload.correction_reason and payload.correction_reason.strip())
    ):
        raise HTTPException(422, "Enter a correction reason when changing a teacher-confirmed mark")
    row.teacher_score = payload.score
    row.max_marks = rubric_item.max_marks
    if payload.correction_reason is not None:
        row.correction_reason = payload.correction_reason.strip() or None
    row.confirmed_by = membership.user_id
    row.confirmed_at = datetime.now(timezone.utc)
    paper.status = "reviewed"
    rubric.is_locked = True
    _audit(
        db,
        org,
        membership.user_id,
        "grade.teacher_confirmed",
        "grade",
        row.id,
        {
            "paper_id": str(paper.id),
            "previous_score": previous_score,
            "score": payload.score,
            "max_marks": float(rubric_item.max_marks),
            "previous_confirmed_at": previous_confirmed_at,
            "correction_reason": row.correction_reason,
        },
    )
    db.flush()
    rubric_items = db.scalars(select(RubricItem).where(RubricItem.rubric_id == rubric.id)).all()
    grades = db.scalars(
        select(Grade).where(
            Grade.paper_id == paper.id, Grade.rubric_item_id.in_([item.id for item in rubric_items])
        )
    ).all()
    if (
        rubric_items
        and len(grades) == len(rubric_items)
        and all(grade.teacher_score is not None for grade in grades)
    ):
        total_score = sum(Decimal(str(grade.teacher_score)) for grade in grades)
        exam = db.get(Exam, paper.exam_id)
        result = db.scalar(
            select(ExamResult).where(
                ExamResult.exam_id == exam.id,
                ExamResult.student_id == paper.student_id,
                ExamResult.organization_id == org,
            )
        )
        if result is None:
            result = ExamResult(
                organization_id=org,
                exam_id=exam.id,
                student_id=paper.student_id,
                total_score=total_score,
                max_marks=exam.max_marks,
                status="finalized",
            )
            db.add(result)
        else:
            previous_total = float(result.total_score)
            previous_status = result.status
            result.total_score = total_score
            result.max_marks = exam.max_marks
            result.status = "finalized"
            if previous_status == "published":
                result.published_at = None
                _audit(
                    db,
                    org,
                    membership.user_id,
                    "exam_result.unpublished_after_mark_correction",
                    "exam_result",
                    result.id,
                    {"previous_total": previous_total, "revised_total": float(total_score)},
                )
        result.updated_at = datetime.now(timezone.utc)
        db.flush()
        _audit(
            db,
            org,
            membership.user_id,
            "exam_result.finalized",
            "exam_result",
            result.id,
            {
                "exam_id": str(exam.id),
                "student_id": str(paper.student_id),
                "total_score": float(total_score),
                "max_marks": float(exam.max_marks),
            },
        )
    db.commit()
    return {
        "id": row.id,
        "paper_id": row.paper_id,
        "rubric_item_id": row.rubric_item_id,
        "teacher_score": float(row.teacher_score),
        "max_marks": float(row.max_marks),
        "confirmed_at": row.confirmed_at,
    }


@router.get("/results")
def results(
    exam_id: UUID | None = None,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    org = membership.organization_id
    stmt = select(ExamResult).where(
        ExamResult.organization_id == org, ExamResult.status.in_(["finalized", "published"])
    )
    if exam_id:
        _org_row(db, Exam, exam_id, org, "Exam not found")
        stmt = stmt.where(ExamResult.exam_id == exam_id)
    rows = db.scalars(stmt.order_by(ExamResult.updated_at.desc())).all()
    result_rows = []
    for result in rows:
        student = _org_row(db, Student, result.student_id, org, "Student not found")
        result_rows.append(
            {
                "exam_id": result.exam_id,
                "student_id": student.id,
                "student_name": f"{student.first_name} {student.last_name}",
                "admission_number": student.admission_number,
                "total_score": float(result.total_score),
                "max_marks": float(result.max_marks),
                "status": result.status,
            }
        )
    return result_rows


@router.post("/results/{exam_id}/{student_id}/publish")
def publish_result(
    exam_id: UUID,
    student_id: UUID,
    membership: OrganizationMembership = Depends(require_roles(*MANAGERS)),
    db: Session = Depends(get_db),
):
    _org_row(db, Exam, exam_id, membership.organization_id, "Exam not found")
    result = db.scalar(
        select(ExamResult).where(
            ExamResult.organization_id == membership.organization_id,
            ExamResult.exam_id == exam_id,
            ExamResult.student_id == student_id,
        )
    )
    if not result or result.status not in ("finalized", "published"):
        raise HTTPException(409, "Only teacher-finalized results can be published")
    if result.status != "published":
        result.status = "published"
        result.published_at = datetime.now(timezone.utc)
        _audit(
            db,
            membership.organization_id,
            membership.user_id,
            "exam_result.published",
            "exam_result",
            result.id,
            {"exam_id": str(exam_id), "student_id": str(student_id)},
        )
        db.commit()
    return {
        "exam_id": result.exam_id,
        "student_id": result.student_id,
        "status": result.status,
        "published_at": result.published_at,
    }


@router.get("/results/export.csv")
def export_results(
    exam_id: UUID | None = None,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = results(exam_id, membership, db)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(
        [
            "Exam ID",
            "Student",
            "Admission number",
            "Teacher-confirmed score",
            "Maximum marks",
            "Status",
        ]
    )
    for row in rows:
        writer.writerow(
            [
                _spreadsheet_text(row["exam_id"]),
                _spreadsheet_text(row["student_name"]),
                _spreadsheet_text(row["admission_number"]),
                row["total_score"],
                row["max_marks"],
                _spreadsheet_text(row["status"]),
            ]
        )
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=gradeflow-results.csv"},
    )


def _spreadsheet_text(value: object) -> str:
    text = str(value)
    if text.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        return "'" + text
    return text


@router.get("/results/export.xlsx")
def export_results_xlsx(
    exam_id: UUID | None = None,
    membership: OrganizationMembership = Depends(get_current_membership),
    db: Session = Depends(get_db),
):
    rows = results(exam_id, membership, db)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Confirmed results"
    sheet.append(
        [
            "Exam ID",
            "Student",
            "Admission number",
            "Teacher-confirmed score",
            "Maximum marks",
            "Status",
        ]
    )
    for row in rows:
        sheet.append(
            [
                _spreadsheet_text(row["exam_id"]),
                _spreadsheet_text(row["student_name"]),
                _spreadsheet_text(row["admission_number"]),
                row["total_score"],
                row["max_marks"],
                _spreadsheet_text(row["status"]),
            ]
        )
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for column, width in {"A": 38, "B": 28, "C": 24, "D": 26, "E": 20, "F": 16}.items():
        sheet.column_dimensions[column].width = width
    output = io.BytesIO()
    workbook.save(output)
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": "attachment; filename=gradeflow-results.xlsx",
            "Cache-Control": "private, no-store",
        },
    )


@router.get("/audit")
def audit(
    membership: OrganizationMembership = Depends(
        require_roles("owner", "school_admin", "reviewer")
    ),
    page: int = Query(1, ge=1),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.organization_id == membership.organization_id)
        .order_by(AuditEvent.created_at.desc())
        .offset((page - 1) * 50)
        .limit(50)
    ).all()
    return [
        {
            "id": row.id,
            "actor_user_id": row.actor_user_id,
            "action": row.action,
            "entity_type": row.entity_type,
            "entity_id": row.entity_id,
            "details": row.details,
            "created_at": row.created_at,
        }
        for row in rows
    ]
