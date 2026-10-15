from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import UUID

from celery import Celery
from sqlalchemy import select

from app.core.config import settings
from app.database import SessionLocal
from app.models import (
    Exam,
    ExtractionResult,
    Grade,
    GradingRun,
    Paper,
    ProcessingJob,
    Rubric,
    RubricItem,
)
from app.services.scripts import assemble_script_pdf
from app.services.vision import extract_answers, propose_grades

celery_app = Celery(
    "gradeflow", broker=settings.celery_broker_url, backend=settings.celery_result_backend
)
celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)


def _fail(db, job: ProcessingJob, paper: Paper, message: str):
    job.status = "failed"
    job.error_message = message[:500]
    job.updated_at = datetime.now(timezone.utc)
    paper.status = "failed"
    db.commit()


@celery_app.task(bind=True, max_retries=2, name="gradeflow.extract_paper")
def extract_paper(self, job_id: str):
    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, UUID(job_id))
        if not job:
            return
        paper = db.get(Paper, job.paper_id)
        if not paper:
            _fail(db, job, job.paper, "Paper record is missing")
            return
        job.status = "processing"
        job.progress = 10
        job.attempts += 1
        job.error_message = None
        paper.status = "processing"
        db.commit()
        job.progress = 25
        db.commit()
        script_pdf = assemble_script_pdf(db, paper)
        with NamedTemporaryFile(suffix=".pdf") as rendered:
            rendered.write(script_pdf)
            rendered.flush()
            result, provider, model = extract_answers(Path(rendered.name))
        job.progress = 85
        db.commit()
        existing = db.scalar(
            select(ExtractionResult)
            .where(ExtractionResult.paper_id == paper.id)
            .order_by(ExtractionResult.created_at.desc())
        )
        if existing:
            existing.answers = [answer.model_dump() for answer in result.answers]
            existing.warnings = result.warnings
            existing.provider = provider
            existing.model = model
            existing.status = "needs_review"
            existing.confirmed_at = None
        else:
            db.add(
                ExtractionResult(
                    organization_id=paper.organization_id,
                    paper_id=paper.id,
                    answers=[answer.model_dump() for answer in result.answers],
                    provider=provider,
                    model=model,
                    warnings=result.warnings,
                    status="needs_review",
                )
            )
        paper.status = "needs_review"
        job.status = "completed"
        job.progress = 100
        job.error_message = None
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
    except Exception as exc:
        db.rollback()
        try:
            job = db.get(ProcessingJob, UUID(job_id))
            paper = db.get(Paper, job.paper_id) if job else None
            if job and paper:
                if self.request.retries < self.max_retries:
                    job.status = "queued"
                    job.error_message = "Temporary processing failure; retrying."
                    db.commit()
                    raise self.retry(exc=exc, countdown=2 ** (self.request.retries + 1))
                _fail(
                    db,
                    job,
                    paper,
                    "Extraction failed. Check the scan and provider configuration before retrying.",
                )
        except self.MaxRetriesExceededError:
            pass
        except Exception:
            if self.request.retries >= self.max_retries:
                pass
            else:
                raise
    finally:
        db.close()


@celery_app.task(bind=True, max_retries=2, name="gradeflow.grade_paper")
def grade_paper(self, job_id: str):
    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, UUID(job_id))
        if not job:
            return
        paper = db.get(Paper, job.paper_id)
        if not paper or not paper.student_id:
            raise ValueError("Assign the script to a student before grading")
        extraction = db.scalar(
            select(ExtractionResult)
            .where(ExtractionResult.paper_id == paper.id, ExtractionResult.status == "confirmed")
            .order_by(ExtractionResult.created_at.desc())
        )
        rubric = db.get(Rubric, job.rubric_id) if job.rubric_id else db.scalar(
            select(Rubric).where(Rubric.exam_id == paper.exam_id).order_by(Rubric.version.desc())
        )
        if rubric and rubric.exam_id != paper.exam_id:
            raise ValueError("The queued rubric does not belong to this examination")
        if not extraction or not rubric:
            raise ValueError("Confirm extraction and save a marking rubric before grading")
        items = db.scalars(
            select(RubricItem)
            .where(RubricItem.rubric_id == rubric.id)
            .order_by(RubricItem.question_number)
        ).all()
        if sum(float(item.max_marks) for item in items) != float(
            db.get(Exam, paper.exam_id).max_marks
        ):
            raise ValueError("Rubric marks do not match the examination total")
        job.status = "processing"
        job.progress = 15
        job.attempts += 1
        paper.status = "grading"
        rubric.is_locked = True
        db.commit()
        rubric_data = [
            {
                "question_number": item.question_number,
                "prompt": item.prompt,
                "expected_answer": item.expected_answer,
                "alternatives": item.alternatives,
                "criteria": item.criteria,
                "max_marks": float(item.max_marks),
            }
            for item in items
        ]
        proposed, provider, model = propose_grades(extraction.answers, rubric_data)
        proposal_numbers = [item.question_number for item in proposed.grades]
        expected_numbers = {item.question_number for item in items}
        if len(proposal_numbers) != len(set(proposal_numbers)) or set(proposal_numbers) != expected_numbers:
            raise ValueError("Grading provider returned duplicate or incomplete question entries")
        run = GradingRun(
            organization_id=paper.organization_id,
            paper_id=paper.id,
            rubric_id=rubric.id,
            status="completed",
            provider=provider,
            model=model,
        )
        db.add(run)
        db.flush()
        for proposal in proposed.grades:
            rubric_item = next(
                item for item in items if item.question_number == proposal.question_number
            )
            row = db.scalar(
                select(Grade).where(
                    Grade.paper_id == paper.id, Grade.rubric_item_id == rubric_item.id
                )
            )
            if row is None:
                row = Grade(
                    organization_id=paper.organization_id,
                    paper_id=paper.id,
                    rubric_item_id=rubric_item.id,
                    max_marks=rubric_item.max_marks,
                )
                db.add(row)
            row.ai_score = proposal.score
            row.ai_confidence = proposal.confidence
            row.ai_warning = proposal.warning
            row.max_marks = rubric_item.max_marks
            row.explanation = proposal.explanation
            row.evidence = proposal.evidence
        run.warnings = proposed.warnings
        paper.status = "needs_review"
        job.status = "completed"
        job.progress = 100
        job.error_message = None
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
    except Exception:
        db.rollback()
        try:
            job = db.get(ProcessingJob, UUID(job_id))
            paper = db.get(Paper, job.paper_id) if job else None
            if job and paper:
                if self.request.retries < self.max_retries:
                    job.status = "queued"
                    job.error_message = "Temporary grading failure; retrying."
                    db.commit()
                    raise self.retry(countdown=2 ** (self.request.retries + 1))
                _fail(
                    db,
                    job,
                    paper,
                    "AI grading failed. The extracted text and original scan remain available for review.",
                )
        except self.MaxRetriesExceededError:
            pass
        except Exception:
            if self.request.retries >= self.max_retries:
                pass
            else:
                raise
    finally:
        db.close()
