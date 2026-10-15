import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock3,
  FileCheck2,
  RotateCw,
  ScanEye,
  ShieldAlert,
  UserRound,
} from "lucide-react";
import {
  api,
  type Page,
  type Paper,
  type ProcessingJob,
  type Student,
} from "../../services/api";
import { useAuth } from "../../app/auth";
import {
  ErrorState,
  EmptyState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";

type Answer = {
  question_number: string;
  answer_text: string;
  page_number: number;
  confidence: number;
  source_region: string | null;
  warning: string | null;
};
type PageEntry = {
  id: string;
  source_paper_id: string | null;
  source_page_number: number;
  rendered_page_number: number;
  page_number: number;
  rotation: number;
  flagged: boolean;
};
type GradeView = {
  ai_score: number | null;
  ai_confidence: number | null;
  ai_warning: string | null;
  teacher_score: number | null;
  max_marks: number;
  explanation: string | null;
  evidence: string | null;
  correction_reason: string | null;
  confirmed_at: string | null;
};
type RubricItem = {
  id: string;
  question_number: string;
  prompt: string;
  expected_answer: string;
  alternatives: string[];
  criteria: string;
  max_marks: number;
  grade: GradeView | null;
};
type ReviewData = {
  paper: Paper;
  exam: {
    id: string;
    title: string;
    max_marks: number;
    class_id: string;
    academic_year_id: string;
  };
  student: { id: string; name: string; admission_number: string } | null;
  pages: PageEntry[];
  extraction: {
    id: string;
    answers: Answer[];
    warnings: string[];
    status: string;
    provider: string;
    model: string;
    created_at: string;
  } | null;
  rubric: {
    id: string;
    version: number;
    is_locked: boolean;
    items: RubricItem[];
  } | null;
};

function tone(status: string): "green" | "amber" | "blue" | "neutral" {
  if (["reviewed", "ready", "completed"].includes(status)) return "green";
  if (status === "failed") return "neutral";
  if (["needs_review", "review", "grading"].includes(status)) return "blue";
  return "amber";
}

const activeJob = (status: string) => ["queued", "processing"].includes(status);

export function ReviewPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const [selectedId, setSelectedId] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [scores, setScores] = useState<Record<string, string>>({});
  const [correction, setCorrection] = useState("");
  const [studentSearch, setStudentSearch] = useState("");
  const [feedback, setFeedback] = useState("");
  const [failure, setFailure] = useState("");
  const isMarker = [
    "owner",
    "school_admin",
    "exam_officer",
    "teacher_marker",
    "reviewer",
  ].includes(user?.role || "");
  const paperQuery = new URLSearchParams({
    page: String(page),
    page_size: "25",
  });
  if (filter !== "all") paperQuery.set("status", filter);
  const papers = useQuery({
    queryKey: ["papers", filter, page],
    queryFn: () => api<Page<Paper>>(`/papers?${paperQuery.toString()}`),
    placeholderData: (previous) => previous,
  });
  const rows = papers.data?.items || [];
  const detail = useQuery({
    queryKey: ["review-data", selectedId],
    queryFn: () => api<ReviewData>(`/papers/${selectedId}/review-data`),
    enabled: Boolean(selectedId),
  });
  const current = detail.data;
  const studentParams = new URLSearchParams({
    page: "1",
    page_size: "50",
    is_active: "true",
    search: studentSearch,
  });
  if (current) {
    studentParams.set("class_id", current.exam.class_id);
    studentParams.set("academic_year_id", current.exam.academic_year_id);
  }
  const students = useQuery({
    queryKey: [
      "students",
      "script-assignment",
      current?.exam.id,
      studentSearch,
    ],
    queryFn: () => api<Page<Student>>(`/students?${studentParams.toString()}`),
    enabled: Boolean(current),
  });
  const jobs = useQuery({
    queryKey: ["jobs", selectedId],
    queryFn: () =>
      api<Page<ProcessingJob>>(
        `/processing/jobs?paper_id=${selectedId}&page=1`,
      ),
    enabled: Boolean(selectedId),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => activeJob(job.status))
        ? 2500
        : false,
  });

  useEffect(() => {
    if (!selectedId && rows.length) setSelectedId(rows[0].id);
    else if (selectedId && !rows.some((paper) => paper.id === selectedId))
      setSelectedId(rows[0]?.id || "");
  }, [selectedId, rows]);
  useEffect(() => {
    setStudentSearch("");
    setFeedback("");
    setFailure("");
  }, [selectedId]);
  useEffect(() => {
    if (detail.data) {
      setAnswers(detail.data.extraction?.answers || []);
      const next: Record<string, string> = {};
      for (const item of detail.data.rubric?.items || []) {
        const score = item.grade?.teacher_score ?? item.grade?.ai_score;
        if (score != null) next[item.id] = String(score);
      }
      setScores(next);
      setCorrection("");
    }
  }, [detail.data]);

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["papers"] }),
      client.invalidateQueries({ queryKey: ["dashboard"] }),
      client.invalidateQueries({ queryKey: ["review-data", selectedId] }),
      client.invalidateQueries({ queryKey: ["results"] }),
      client.invalidateQueries({ queryKey: ["jobs", selectedId] }),
    ]);
  };
  const assign = useMutation({
    mutationFn: (studentId: string) =>
      api(`/papers/${selectedId}/assignment`, {
        method: "PATCH",
        body: JSON.stringify({ student_id: studentId || null }),
      }),
    onSuccess: async () => {
      setFeedback(
        "Student assignment saved. Verify the name and scan before grading.",
      );
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const saveExtraction = useMutation({
    mutationFn: () =>
      api(`/papers/${selectedId}/extraction`, {
        method: "PUT",
        body: JSON.stringify({
          answers,
          warnings: detail.data?.extraction?.warnings || [],
        }),
      }),
    onSuccess: async () => {
      setFeedback(
        "Transcription corrections saved. Confirm the text before requesting AI grading.",
      );
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const confirmExtraction = useMutation({
    mutationFn: () =>
      api(`/papers/${selectedId}/extraction/confirm`, { method: "POST" }),
    onSuccess: async () => {
      setFeedback("Transcription confirmed by a teacher.");
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const extract = useMutation({
    mutationFn: () =>
      api<{ status?: string; error_message?: string }>(
        `/papers/${selectedId}/extract`,
        {
          method: "POST",
          headers: { "Idempotency-Key": `extract-${selectedId}-${Date.now()}` },
        },
      ),
    onSuccess: async (result) => {
      setFeedback(
        result.error_message ||
          `Extraction job status: ${result.status || "queued"}.`,
      );
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const grade = useMutation({
    mutationFn: () =>
      api<{ status?: string; error_message?: string }>(
        `/papers/${selectedId}/grade`,
        {
          method: "POST",
          headers: { "Idempotency-Key": `grade-${selectedId}-${Date.now()}` },
        },
      ),
    onSuccess: async (result) => {
      setFeedback(
        result.error_message ||
          `AI grading job status: ${result.status || "queued"}.`,
      );
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const retry = useMutation({
    mutationFn: (jobId: string) =>
      api(`/processing/jobs/${jobId}/retry`, { method: "POST" }),
    onSuccess: async () => {
      setFeedback(
        "Retry request recorded. The job status will update when the worker reports progress.",
      );
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const mark = useMutation({
    mutationFn: ({ item, value }: { item: RubricItem; value: number }) =>
      api(`/papers/${selectedId}/grades/confirm`, {
        method: "POST",
        body: JSON.stringify({
          rubric_item_id: item.id,
          score: value,
          correction_reason: correction || null,
        }),
      }),
    onSuccess: async () => {
      setFeedback(
        "Teacher-confirmed mark saved. Result totals are recalculated on the server.",
      );
      await refresh();
    },
    onError: (error: Error) => setFailure(error.message),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) =>
      api(`/papers/${selectedId}/pages/order`, {
        method: "PUT",
        body: JSON.stringify({ page_ids: ids }),
      }),
    onSuccess: refresh,
    onError: (error: Error) => setFailure(error.message),
  });
  const rotate = useMutation({
    mutationFn: ({ item, rotation }: { item: PageEntry; rotation: number }) =>
      api(`/papers/${selectedId}/pages/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ rotation }),
      }),
    onSuccess: refresh,
    onError: (error: Error) => setFailure(error.message),
  });
  const flag = useMutation({
    mutationFn: (item: PageEntry) =>
      api(`/papers/${selectedId}/pages/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ flagged: !item.flagged }),
      }),
    onSuccess: refresh,
    onError: (error: Error) => setFailure(error.message),
  });
  const jobsData = jobs.data?.items || [];
  const pageCount = papers.data
    ? Math.max(1, Math.ceil(papers.data.total / papers.data.page_size))
    : 1;

  if (papers.isPending) return <Loading label="Loading examination scripts…" />;
  if (papers.isError || !papers.data)
    return (
      <ErrorState
        message={papers.error?.message || "Review queue is unavailable."}
        onRetry={() => void papers.refetch()}
      />
    );
  const movePage = (index: number, direction: -1 | 1) => {
    if (!current) return;
    const ids = current.pages.map((item) => item.id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    reorder.mutate(ids);
  };

  return (
    <>
      <section className="panel pad review-toolbar">
        <SectionTitle
          eyebrow="TEACHER CONTROL"
          title="Review queue"
          detail="Inspect private scans and confirm every final mark. AI output is provisional and review actions are audited."
          action={
            <label className="filter-select">
              <span className="sr-only">
                Filter scripts by processing status
              </span>
              <select
                className="field"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">All papers</option>
                <option value="uploaded">Uploaded</option>
                <option value="queued">Queued</option>
                <option value="processing">Processing</option>
                <option value="needs_review">Needs review</option>
                <option value="ready">Ready to grade</option>
                <option value="review">Teacher review</option>
                <option value="reviewed">Teacher approved</option>
                <option value="failed">Failed</option>
              </select>
            </label>
          }
        />
        <div className="review-layout">
          <section className="panel review-queue-panel">
            <div className="queue-heading">
              <b>Paper scripts</b>
              <StatusTag tone="neutral">
                {papers.data.total.toLocaleString()} total
              </StatusTag>
            </div>
            <div className="review-list">
              {rows.map((paper) => (
                <button
                  key={paper.id}
                  className={`review-item ${selectedId === paper.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedId(paper.id);
                    setFeedback("");
                    setFailure("");
                  }}
                >
                  <span className="review-icon">
                    <FileCheck2 size={16} />
                  </span>
                  <span className="review-doc">
                    <b>{paper.file_name}</b>
                    <small>
                      {new Date(paper.created_at).toLocaleDateString()} ·{" "}
                      {paper.size_bytes.toLocaleString()} bytes
                    </small>
                  </span>
                  <StatusTag tone={tone(paper.status)}>
                    {paper.status.replace("_", " ")}
                  </StatusTag>
                </button>
              ))}
              {!rows.length && (
                <EmptyState
                  title={
                    papers.data.total
                      ? "No papers on this page"
                      : "No examination scripts yet"
                  }
                  detail={
                    papers.data.total
                      ? "Change pages or select a different processing status."
                      : "Create an exam batch, then upload a PDF or scan image. Only real authorized school records appear here."
                  }
                  action={
                    !papers.data.total && (
                      <a className="btn" href="/batches">
                        Open exam batches
                      </a>
                    )
                  }
                />
              )}
            </div>
            <div className="pagination review-pagination">
              <button
                className="btn"
                disabled={page <= 1}
                onClick={() =>
                  setPage((currentPage) => Math.max(1, currentPage - 1))
                }
              >
                Previous
              </button>
              <span>
                {rows.length ? (page - 1) * papers.data.page_size + 1 : 0}–
                {Math.min(page * papers.data.page_size, papers.data.total)} of{" "}
                {papers.data.total}
              </span>
              <button
                className="btn"
                disabled={page >= pageCount}
                onClick={() =>
                  setPage((currentPage) => Math.min(pageCount, currentPage + 1))
                }
              >
                Next
              </button>
            </div>
          </section>
          {selectedId && (
            <section className="panel review-detail">
              {detail.isPending && (
                <Loading label="Opening the private paper record…" />
              )}
              {detail.isError && (
                <ErrorState
                  message={detail.error.message}
                  onRetry={() => void detail.refetch()}
                />
              )}
              {current && (
                <>
                  <div className="review-detail-head">
                    <div>
                      <div className="eyebrow">{current.exam.title}</div>
                      <h2>{current.student?.name || "Unassigned student"}</h2>
                      <p className="muted small">
                        {current.student?.admission_number ||
                          "Student identity not confirmed"}{" "}
                        · {current.exam.max_marks} maximum marks
                      </p>
                    </div>
                    <StatusTag tone={tone(current.paper.status)}>
                      {current.paper.status.replace("_", " ")}
                    </StatusTag>
                  </div>
                  <div className="review-assignment">
                    <label htmlFor="student-assignment">
                      <UserRound size={15} /> Confirm student identity
                    </label>
                    <input
                      className="field"
                      type="search"
                      value={studentSearch}
                      onChange={(event) => setStudentSearch(event.target.value)}
                      aria-label="Find enrolled students"
                      placeholder="Search enrolled students by name or admission number"
                    />
                    <select
                      id="student-assignment"
                      className="field"
                      value={current.student?.id || ""}
                      onChange={(event) => assign.mutate(event.target.value)}
                      disabled={assign.isPending}
                    >
                      <option value="">
                        Unassigned — verify before grading
                      </option>
                      {current.student &&
                        !students.data?.items.some(
                          (student) => student.id === current.student?.id,
                        ) && (
                          <option value={current.student.id}>
                            {current.student.name} ·{" "}
                            {current.student.admission_number} (current)
                          </option>
                        )}
                      {(students.data?.items || []).map((student) => (
                        <option key={student.id} value={student.id}>
                          {student.first_name} {student.last_name} ·{" "}
                          {student.admission_number}
                        </option>
                      ))}
                    </select>
                    {students.isError && (
                      <small className="field-error">
                        {students.error.message}
                      </small>
                    )}
                    {students.data && (
                      <small className="muted">
                        {students.data.total} active enrollment(s) in the
                        examination class/year.
                      </small>
                    )}
                  </div>
                  <div className="review-evidence-grid">
                    <div>
                      <div className="section-mini-heading">
                        <h3>Original scan</h3>
                        <span className="muted small">
                          Authorized preview · private
                        </span>
                      </div>
                      <iframe
                        className="paper-frame"
                        src={`/api/v1/papers/${current.paper.id}/file`}
                        title={`Private scan for ${current.student?.name || current.paper.file_name}`}
                      />
                    </div>
                    <div>
                      <div className="section-mini-heading">
                        <h3>Page order &amp; scan quality</h3>
                        <span className="muted small">
                          {current.pages.length} page(s)
                        </span>
                      </div>
                      <div className="review-page-stack">
                        {current.pages.map((item, index) => (
                          <div className="review-page-preview" key={item.id}>
                            <img
                              loading="lazy"
                              src={`/api/v1/papers/${current.paper.id}/pages/${item.id}/preview`}
                              alt={`Authorized preview of page ${item.page_number}`}
                            />
                            <small>
                              Script page {item.page_number}
                              <br />
                              Original scan page {item.source_page_number}
                              {item.rotation
                                ? ` · rotated ${item.rotation}°`
                                : ""}
                              {item.flagged ? " · flagged" : ""}
                            </small>
                            <small className="page-source">
                              Source record{" "}
                              {item.source_paper_id
                                ? `${item.source_paper_id.slice(0, 8)}…`
                                : "not available"}
                            </small>
                            <div className="actions-row">
                              <button
                                className="icon-button"
                                title="Rotate 90° clockwise"
                                aria-label={`Rotate page ${item.page_number}`}
                                onClick={() =>
                                  rotate.mutate({
                                    item,
                                    rotation: (item.rotation + 90) % 360,
                                  })
                                }
                              >
                                <RotateCw size={14} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`Move page ${item.page_number} up`}
                                disabled={index === 0}
                                onClick={() => movePage(index, -1)}
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`Move page ${item.page_number} down`}
                                disabled={index === current.pages.length - 1}
                                onClick={() => movePage(index, 1)}
                              >
                                <ArrowDown size={14} />
                              </button>
                              <button
                                className={`icon-button ${item.flagged ? "flag-active" : ""}`}
                                aria-label={`${item.flagged ? "Clear flag on" : "Flag"} page ${item.page_number}`}
                                onClick={() => flag.mutate(item)}
                              >
                                <ShieldAlert size={14} />
                              </button>
                            </div>
                          </div>
                        ))}
                        {!current.pages.length && (
                          <p className="muted small">
                            No page details are available.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {jobsData.length > 0 && (
                    <div className="review-subsection">
                      <SectionTitle
                        title="Background processing"
                        detail="Persistent extraction and grading history. Live worker updates refresh automatically."
                        action={<Clock3 size={16} />}
                      />
                      {jobsData.slice(0, 5).map((job) => (
                        <div className="processing-card" key={job.id}>
                          <div className="processing-card-head">
                            <div>
                              <b>
                                {job.task_type === "extract"
                                  ? "Answer extraction"
                                  : "AI grading proposal"}
                              </b>
                              <small>
                                {" "}
                                · {job.attempts} attempt(s) ·{" "}
                                {new Date(job.created_at).toLocaleString()}
                              </small>
                            </div>
                            <StatusTag tone={tone(job.status)}>
                              {job.status}
                            </StatusTag>
                          </div>
                          {activeJob(job.status) && (
                            <div
                              className="progress-track"
                              aria-label={`${job.progress}% complete`}
                            >
                              <span style={{ width: `${job.progress}%` }} />
                            </div>
                          )}
                          {job.error_message && (
                            <p className="processing-card-error">
                              {job.error_message}
                            </p>
                          )}
                          {job.status === "failed" &&
                            job.attempts < 3 &&
                            isMarker && (
                              <button
                                className="btn"
                                disabled={retry.isPending}
                                onClick={() => retry.mutate(job.id)}
                              >
                                {retry.isPending ? "Retrying…" : "Retry job"}
                              </button>
                            )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="review-subsection">
                    <SectionTitle
                      title="Answer extraction"
                      detail="Review and correct source-linked answers before explicit teacher confirmation."
                      action={
                        current.extraction && (
                          <StatusTag
                            tone={
                              current.extraction.status === "confirmed"
                                ? "green"
                                : "amber"
                            }
                          >
                            {current.extraction.status.replace("_", " ")}
                          </StatusTag>
                        )
                      }
                    />
                    {current.extraction ? (
                      <>
                        <div className="extraction-meta">
                          Provider: {current.extraction.provider} · Model:{" "}
                          {current.extraction.model} ·{" "}
                          {new Date(
                            current.extraction.created_at,
                          ).toLocaleString()}
                        </div>
                        {current.extraction.warnings.length > 0 && (
                          <div className="alert alert-info">
                            <ShieldAlert size={15} />
                            {current.extraction.warnings.join(" · ")}
                          </div>
                        )}
                        {answers.map((answer, index) => (
                          <div
                            className="answer-edit"
                            key={`${current.extraction?.id}:${index}`}
                          >
                            <div className="form-grid">
                              <div>
                                <label
                                  className="label"
                                  htmlFor={`answer-question-${index}`}
                                >
                                  Question number
                                </label>
                                <input
                                  className="field"
                                  id={`answer-question-${index}`}
                                  value={answer.question_number}
                                  onChange={(event) =>
                                    setAnswers((list) =>
                                      list.map((entry, i) =>
                                        i === index
                                          ? {
                                              ...entry,
                                              question_number:
                                                event.target.value,
                                            }
                                          : entry,
                                      ),
                                    )
                                  }
                                />
                              </div>
                              <div>
                                <label
                                  className="label"
                                  htmlFor={`answer-page-${index}`}
                                >
                                  Source page
                                </label>
                                <select
                                  className="field"
                                  id={`answer-page-${index}`}
                                  value={answer.page_number}
                                  onChange={(event) =>
                                    setAnswers((list) =>
                                      list.map((entry, i) =>
                                        i === index
                                          ? {
                                              ...entry,
                                              page_number: Number(
                                                event.target.value,
                                              ),
                                            }
                                          : entry,
                                      ),
                                    )
                                  }
                                >
                                  {current.pages.map((item) => (
                                    <option
                                      key={item.id}
                                      value={item.page_number}
                                    >
                                      Page {item.page_number}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <label
                              className="label"
                              htmlFor={`answer-text-${index}`}
                            >
                              Extracted answer · confidence{" "}
                              {Math.round(answer.confidence * 100)}%
                              {answer.source_region
                                ? ` · ${answer.source_region}`
                                : ""}
                            </label>
                            <textarea
                              className="field"
                              rows={3}
                              id={`answer-text-${index}`}
                              value={answer.answer_text}
                              onChange={(event) =>
                                setAnswers((list) =>
                                  list.map((entry, i) =>
                                    i === index
                                      ? {
                                          ...entry,
                                          answer_text: event.target.value,
                                        }
                                      : entry,
                                  ),
                                )
                              }
                            />
                            {answer.warning && (
                              <div className="field-error">
                                {answer.warning}
                              </div>
                            )}
                          </div>
                        ))}
                        {answers.length === 0 && (
                          <p className="muted small">
                            No answer text was extracted. Correct the scan, then
                            explicitly save/confirm the transcription before
                            grading.
                          </p>
                        )}
                        <div className="actions-row">
                          <button
                            className="btn"
                            onClick={() => saveExtraction.mutate()}
                            disabled={saveExtraction.isPending}
                          >
                            {saveExtraction.isPending
                              ? "Saving…"
                              : "Save corrections"}
                          </button>
                          <button
                            className="btn primary"
                            onClick={() => confirmExtraction.mutate()}
                            disabled={
                              confirmExtraction.isPending ||
                              current.extraction.status === "confirmed"
                            }
                          >
                            <Check size={15} />
                            {confirmExtraction.isPending
                              ? "Confirming…"
                              : "Confirm transcription"}
                          </button>
                        </div>
                        {current.extraction.status === "confirmed" && (
                          <button
                            className="btn ai-grade-button"
                            onClick={() => grade.mutate()}
                            disabled={
                              !current.student ||
                              !current.rubric ||
                              grade.isPending
                            }
                          >
                            <ScanEye size={15} />
                            {grade.isPending
                              ? "Queueing…"
                              : "Request AI grading"}
                          </button>
                        )}
                      </>
                    ) : (
                      <div className="empty-inline">
                        <p className="muted small">
                          No extraction is stored. Extraction uses the
                          configured vision service and background worker;
                          without credentials and a running worker, the system
                          does not invent a transcript.
                        </p>
                        <button
                          className="btn"
                          onClick={() => extract.mutate()}
                          disabled={extract.isPending}
                        >
                          {extract.isPending
                            ? "Queueing extraction…"
                            : "Request answer extraction"}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="review-subsection">
                    <SectionTitle
                      title="Marking scheme &amp; teacher decision"
                      detail={
                        current.rubric
                          ? `Rubric version ${current.rubric.version} · ${current.rubric.items.length} question${current.rubric.items.length === 1 ? "" : "s"}`
                          : "Save a marking scheme for this examination first."
                      }
                    />
                    {current.rubric?.items.length ? (
                      current.rubric.items.map((item) => {
                        const score = scores[item.id] ?? "";
                        const numeric = score === "" ? NaN : Number(score);
                        const grade = item.grade;
                        return (
                          <div className="grade-question" key={item.id}>
                            <div className="grade-top">
                              <div>
                                <b>{item.question_number}</b>
                                <p className="muted small">{item.prompt}</p>
                              </div>
                              <StatusTag
                                tone={
                                  grade?.ai_score != null ? "blue" : "neutral"
                                }
                              >
                                {grade?.ai_score != null
                                  ? `Proposed ${grade.ai_score}/${item.max_marks}`
                                  : `Maximum ${item.max_marks}`}
                              </StatusTag>
                            </div>
                            <div className="rubric-evidence">
                              <span>
                                <b>Expected:</b> {item.expected_answer}
                              </span>
                              {item.criteria && <small>{item.criteria}</small>}
                              {grade?.evidence && (
                                <small>
                                  <b>Answer evidence:</b> {grade.evidence}
                                </small>
                              )}
                              {grade?.explanation && (
                                <small>
                                  <b>AI rationale:</b> {grade.explanation}
                                </small>
                              )}
                              {grade?.ai_confidence != null && (
                                <small className="grade-confidence">
                                  AI proposal confidence:{" "}
                                  {Math.round(grade.ai_confidence * 100)}%
                                </small>
                              )}
                              {grade?.ai_warning && (
                                <small className="grade-uncertainty">
                                  Uncertainty: {grade.ai_warning}
                                </small>
                              )}
                            </div>
                            <div className="mark-row">
                              <label
                                className="label"
                                htmlFor={`score-${item.id}`}
                              >
                                Teacher-confirmed score
                              </label>
                              <div className="mark-control">
                                <input
                                  className="field grade-input"
                                  type="number"
                                  id={`score-${item.id}`}
                                  min="0"
                                  max={item.max_marks}
                                  step="0.01"
                                  value={score}
                                  onChange={(event) =>
                                    setScores((previous) => ({
                                      ...previous,
                                      [item.id]: event.target.value,
                                    }))
                                  }
                                />
                                <span className="muted small">
                                  / {item.max_marks}
                                </span>
                                <button
                                  className="btn primary"
                                  disabled={
                                    !current.student ||
                                    !Number.isFinite(numeric) ||
                                    numeric < 0 ||
                                    numeric > item.max_marks ||
                                    mark.isPending
                                  }
                                  onClick={() =>
                                    mark.mutate({ item, value: numeric })
                                  }
                                >
                                  {grade?.teacher_score != null
                                    ? "Update confirmed mark"
                                    : "Confirm mark"}
                                </button>
                              </div>
                              {grade?.teacher_score != null && (
                                <small className="text-green">
                                  Confirmed: {grade.teacher_score}/
                                  {grade.max_marks}
                                  {grade.confirmed_at
                                    ? ` · ${new Date(grade.confirmed_at).toLocaleString()}`
                                    : ""}
                                </small>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <EmptyState
                        title="No rubric questions yet"
                        detail="A teacher-defined marking scheme is required before AI grading. You may enter and confirm marks manually after questions are added."
                        action={
                          <a className="btn" href="/questions">
                            Open marking scheme
                          </a>
                        }
                      />
                    )}
                    {current.rubric?.items.some(
                      (item) => item.grade?.ai_score != null,
                    ) && (
                      <>
                        <label className="label" htmlFor="correction-reason">
                          Reason for changing an AI score (required for score
                          corrections)
                        </label>
                        <input
                          className="field"
                          id="correction-reason"
                          value={correction}
                          onChange={(event) =>
                            setCorrection(event.target.value)
                          }
                          placeholder="Explain why the proposed mark was changed"
                        />
                      </>
                    )}
                    {!current.student && (
                      <div className="alert alert-info">
                        Assign this paper to an active, enrolled student before
                        confirming final marks. Uncertain identification remains
                        unassigned.
                      </div>
                    )}
                  </div>
                </>
              )}
              {feedback && (
                <div className="alert alert-success" role="status">
                  {feedback}
                </div>
              )}
              {failure && (
                <div className="alert alert-error" role="alert">
                  {failure}
                  <button className="linkbtn" onClick={() => setFailure("")}>
                    Dismiss
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </section>
    </>
  );
}
