from datetime import date, datetime
from uuid import UUID

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RegisterRequest(BaseModel):
    full_name: str = Field(min_length=2, max_length=160)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)
    school_name: str = Field(min_length=2, max_length=180)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        value = value.strip().lower()
        import re

        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Enter a valid email address")
        return value


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class RegisterResponse(BaseModel):
    requires_verification: bool
    message: str
    verification_path: str | None = None


class TokenRequest(BaseModel):
    token: str = Field(min_length=20, max_length=300)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class ForgotPasswordResponse(BaseModel):
    message: str
    reset_path: str | None = None


class PasswordResetRequest(TokenRequest):
    new_password: str = Field(min_length=12, max_length=128)


class ProfileUpdate(BaseModel):
    full_name: str = Field(min_length=2, max_length=160)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=12, max_length=128)


class InvitationCreate(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    role: Literal["school_admin", "exam_officer", "teacher_marker", "reviewer", "viewer"]

    @field_validator("email")
    @classmethod
    def normalize_email(cls, value: str) -> str:
        return value.strip().lower()


class InvitationAccept(BaseModel):
    token: str = Field(min_length=20, max_length=300)
    full_name: str = Field(min_length=2, max_length=160)
    password: str = Field(min_length=12, max_length=128)


class StaffRoleUpdate(BaseModel):
    role: Literal["school_admin", "exam_officer", "teacher_marker", "reviewer", "viewer"]


class StaffActivationUpdate(BaseModel):
    is_active: bool


class OrganizationUpdate(BaseModel):
    name: str = Field(min_length=2, max_length=180)


class UserView(BaseModel):
    id: UUID
    email: str
    full_name: str
    role: str
    organization_id: UUID
    organization_name: str


class StudentCreate(BaseModel):
    admission_number: str = Field(min_length=1, max_length=60)
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    class_id: UUID | None = None
    academic_year_id: UUID | None = None


class StudentUpdate(BaseModel):
    admission_number: str = Field(min_length=1, max_length=60)
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    is_active: bool = True


class StudentEnrollmentCreate(BaseModel):
    class_id: UUID
    academic_year_id: UUID


class StudentView(BaseModel):
    id: UUID
    admission_number: str
    first_name: str
    last_name: str
    is_active: bool
    class_name: str | None = None
    model_config = ConfigDict(from_attributes=True)


class AcademicYearCreate(BaseModel):
    label: str = Field(min_length=4, max_length=40)
    starts_on: date | None = None
    ends_on: date | None = None
    is_current: bool = False


class AcademicYearView(BaseModel):
    id: UUID
    label: str
    starts_on: date | None
    ends_on: date | None
    is_current: bool


class TermCreate(BaseModel):
    academic_year_id: UUID
    name: str = Field(min_length=1, max_length=40)


class SimpleAcademicCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ExamCreate(BaseModel):
    title: str = Field(min_length=2, max_length=180)
    class_id: UUID
    subject_id: UUID
    academic_year_id: UUID
    term_id: UUID
    exam_type: str = Field(default="Theory", max_length=32)
    max_marks: float = Field(gt=0, le=10000)
    scheduled_on: date | None = None


class ExamView(BaseModel):
    id: UUID
    title: str
    class_id: UUID
    subject_id: UUID
    academic_year_id: UUID
    term_id: UUID
    exam_type: str
    max_marks: float
    scheduled_on: date | None
    status: str
    created_at: datetime


class ExamStatusUpdate(BaseModel):
    status: Literal[
        "draft", "active", "in_progress", "review", "completed", "published", "archived"
    ]


class RubricItemInput(BaseModel):
    question_number: str = Field(min_length=1, max_length=32)
    prompt: str = Field(min_length=1, max_length=5000)
    expected_answer: str = Field(min_length=1, max_length=5000)
    alternatives: list[str] = Field(default_factory=list, max_length=20)
    criteria: str = Field(default="", max_length=10000)
    max_marks: float = Field(gt=0, le=10000)


class RubricSave(BaseModel):
    items: list[RubricItemInput] = Field(min_length=1, max_length=200)


class RubricItemView(RubricItemInput):
    id: UUID


class RubricView(BaseModel):
    id: UUID
    exam_id: UUID
    version: int
    is_locked: bool
    items: list[RubricItemView]


class PaperView(BaseModel):
    id: UUID
    exam_id: UUID
    student_id: UUID | None
    file_name: str
    content_type: str
    size_bytes: int
    status: str
    created_at: datetime


class ExtractedAnswerInput(BaseModel):
    question_number: str = Field(min_length=1, max_length=32)
    answer_text: str = Field(max_length=20000)
    page_number: int = Field(ge=1, le=100)
    confidence: float = Field(ge=0, le=1)
    source_region: str | None = Field(default=None, max_length=300)
    warning: str | None = Field(default=None, max_length=500)


class ExtractionUpdate(BaseModel):
    answers: list[ExtractedAnswerInput] = Field(max_length=250)
    warnings: list[str] = Field(default_factory=list, max_length=100)


class GradeConfirm(BaseModel):
    rubric_item_id: UUID
    score: float = Field(ge=0)
    correction_reason: str | None = Field(default=None, max_length=2000)


class GradeView(BaseModel):
    id: UUID
    paper_id: UUID
    rubric_item_id: UUID
    ai_score: float | None
    teacher_score: float | None
    max_marks: float
    correction_reason: str | None
    confirmed_at: datetime | None


class PageView(BaseModel):
    id: UUID
    paper_id: UUID
    page_number: int
    rotation: int
    flagged: bool


class StudentAssignmentUpdate(BaseModel):
    student_id: UUID | None = None


class PageOrderUpdate(BaseModel):
    page_ids: list[UUID] = Field(min_length=1, max_length=100)


class PageUpdate(BaseModel):
    rotation: Literal[0, 90, 180, 270] | None = None
    flagged: bool | None = None


class ScriptGroup(BaseModel):
    page_ids: list[UUID] = Field(min_length=1, max_length=100)
    student_id: UUID | None = None


class OrganizeScripts(BaseModel):
    exam_id: UUID
    groups: list[ScriptGroup] = Field(min_length=1, max_length=100)


class GroupPageView(BaseModel):
    id: UUID
    paper_id: UUID
    source_paper_id: UUID | None = None
    source_page_number: int
    rendered_page_number: int
    page_number: int
    rotation: int
    flagged: bool
    file_name: str


class GroupPageList(BaseModel):
    items: list[GroupPageView]
    total: int
    page: int
    page_size: int


class ProcessingJobView(BaseModel):
    id: UUID
    paper_id: UUID
    task_type: str
    status: str
    progress: int
    error_message: str | None
    attempts: int
    created_at: datetime


class ResultView(BaseModel):
    exam_id: UUID
    student_id: UUID
    student_name: str
    admission_number: str
    total_score: float
    max_marks: float
    status: str


class Paginated(BaseModel):
    items: list
    total: int
    page: int
    page_size: int
