import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Check,
  FileUp,
  Layers3,
  Pencil,
  Plus,
  Search,
  UploadCloud,
  X,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  api,
  apiUpload,
  type AcademicItem,
  type Exam,
  type ExamDetails,
} from "../../services/api";
import { useAuth } from "../../app/auth";
import {
  EmptyState,
  ErrorState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";
import { ScriptOrganizer } from "./ScriptOrganizer";

const examSchema = z.object({
  title: z.string().trim().min(2, "Enter an exam name").max(180),
  class_id: z.string().min(1, "Choose a class"),
  subject_id: z.string().min(1, "Choose a subject"),
  academic_year_id: z.string().min(1, "Choose an academic year"),
  term_id: z.string().min(1, "Choose a term"),
  exam_type: z.string().min(1).max(32),
  max_marks: z.coerce
    .number()
    .gt(0, "Marks must be greater than zero")
    .max(10000),
  scheduled_on: z.string().optional(),
});
type ExamForm = z.input<typeof examSchema>;
type ExamValues = z.output<typeof examSchema>;
const emptyForm: ExamForm = {
  title: "",
  class_id: "",
  subject_id: "",
  academic_year_id: "",
  term_id: "",
  exam_type: "Theory",
  max_marks: 100,
  scheduled_on: "",
};
const nextStatus: Record<string, string> = {
  draft: "active",
  active: "in_progress",
  in_progress: "review",
  review: "completed",
  completed: "published",
};

function tone(status: string): "green" | "blue" | "amber" | "neutral" {
  if (
    ["active", "in_progress", "reviewed", "completed", "published"].includes(
      status,
    )
  )
    return "green";
  if (["review", "needs_review", "ready"].includes(status)) return "blue";
  if (["failed", "archived"].includes(status)) return "neutral";
  return "amber";
}

export function ExamsPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const cameraInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Exam | null>(null);
  const [selected, setSelected] = useState("");
  const [organizing, setOrganizing] = useState<Exam | null>(null);
  const [detailsId, setDetailsId] = useState("");
  const [uploadMessage, setUploadMessage] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [examError, setExamError] = useState("");
  const isExamManager = ["owner", "school_admin", "exam_officer"].includes(
    user?.role || "",
  );
  const canScan = [
    "owner",
    "school_admin",
    "exam_officer",
    "teacher_marker",
  ].includes(user?.role || "");
  const exams = useQuery({
    queryKey: ["exams"],
    queryFn: () => api<(Exam & { paper_count?: number })[]>("/exams"),
  });
  const years = useQuery({
    queryKey: ["academics", "years"],
    queryFn: () => api<AcademicItem[]>("/academics/years"),
  });
  const terms = useQuery({
    queryKey: ["academics", "terms"],
    queryFn: () => api<AcademicItem[]>("/academics/terms"),
  });
  const classes = useQuery({
    queryKey: ["academics", "classes"],
    queryFn: () => api<AcademicItem[]>("/academics/classes"),
  });
  const subjects = useQuery({
    queryKey: ["academics", "subjects"],
    queryFn: () => api<AcademicItem[]>("/academics/subjects"),
  });
  const details = useQuery({
    queryKey: ["exam-details", detailsId],
    queryFn: () => api<ExamDetails>(`/exams/${detailsId}`),
    enabled: Boolean(detailsId),
  });
  const form = useForm<ExamForm, unknown, ExamValues>({
    resolver: zodResolver(examSchema),
    defaultValues: emptyForm,
  });

  useEffect(() => {
    if (!selected && exams.data?.length) setSelected(exams.data[0].id);
  }, [selected, exams.data]);
  useEffect(() => {
    if (open)
      form.reset(
        editing
          ? {
              title: editing.title,
              class_id: editing.class_id,
              subject_id: editing.subject_id,
              academic_year_id: editing.academic_year_id,
              term_id: editing.term_id,
              exam_type: editing.exam_type,
              max_marks: editing.max_marks,
              scheduled_on: editing.scheduled_on || "",
            }
          : emptyForm,
      );
  }, [editing, form, open]);

  const save = useMutation({
    mutationFn: ({ values, id }: { values: ExamValues; id?: string }) =>
      api<Exam>(id ? `/exams/${id}` : "/exams", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify({
          ...values,
          scheduled_on: values.scheduled_on || null,
        }),
      }),
    onSuccess: async (exam) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["exams"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
        client.invalidateQueries({ queryKey: ["exam-details", exam.id] }),
      ]);
      setSelected(exam.id);
      setOpen(false);
      setEditing(null);
      setExamError("");
      form.reset(emptyForm);
    },
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const formData = new FormData();
      formData.append("exam_id", selected);
      files.forEach((file) => formData.append("files", file));
      return apiUpload<{
        batch_id: string;
        status: string;
        accepted: number;
        rejected: number;
        files: {
          ok: boolean;
          file_name?: string;
          detail?: { message?: string } | string;
        }[];
      }>("/papers/bulk", formData, setUploadProgress);
    },
    onSuccess: async (result) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["papers"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
        client.invalidateQueries({ queryKey: ["upload-batches", selected] }),
        client.invalidateQueries({ queryKey: ["exam-details", selected] }),
        client.invalidateQueries({ queryKey: ["exams"] }),
      ]);
      const rejected = result.files.filter((item) => !item.ok);
      setUploadMessage(
        `${result.accepted} scan${result.accepted === 1 ? "" : "s"} uploaded${rejected.length ? `; ${rejected.length} need attention` : ""}.`,
      );
      setUploadError(
        rejected
          .map(
            (item) =>
              `${item.file_name}: ${typeof item.detail === "string" ? item.detail : item.detail?.message || "not accepted"}`,
          )
          .join(" · "),
      );
    },
    onError: (error: Error) => setUploadError(error.message),
    onSettled: () => window.setTimeout(() => setUploadProgress(0), 1200),
  });

  const statusChange = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/exams/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["exams"] });
      await client.invalidateQueries({ queryKey: ["exam-details"] });
      setExamError("");
    },
    onError: (error: Error) => setExamError(error.message),
  });
  const canCreate = Boolean(
    years.data?.length &&
      terms.data?.length &&
      classes.data?.length &&
      subjects.data?.length,
  );
  const matchingTerms = useMemo(
    () =>
      (terms.data || []).filter(
        (term) =>
          !term.academic_year_id ||
          term.academic_year_id === form.watch("academic_year_id"),
      ),
    [terms.data, form.watch("academic_year_id")],
  );

  const chooseFiles = (files: File[]) => {
    if (!files.length) return;
    setUploadMessage("");
    setUploadError("");
    if (!selected) {
      setUploadError("Choose an examination first.");
      return;
    }
    upload.mutate(files);
  };
  const handleSubmit = form.handleSubmit(async (values) => {
    setExamError("");
    try {
      await save.mutateAsync({ values, id: editing?.id });
    } catch (error) {
      setExamError(
        error instanceof Error ? error.message : "Could not save the exam.",
      );
    }
  });

  if (exams.isPending) return <Loading label="Loading examination records…" />;
  if (exams.isError || !exams.data)
    return (
      <ErrorState
        message={exams.error?.message || "Examinations are unavailable."}
        onRetry={() => void exams.refetch()}
      />
    );

  return (
    <>
      <section className="panel pad">
        <SectionTitle
          eyebrow="ASSESSMENT CYCLES"
          title="Exam batches"
          detail="Create and maintain examination details, then collect and organize private student scripts."
          action={
            isExamManager ? (
              <button
                className="btn primary"
                onClick={() => {
                  setEditing(null);
                  setExamError("");
                  setOpen(true);
                }}
              >
                <Plus size={15} /> New exam batch
              </button>
            ) : undefined
          }
        />
        {examError && !open && (
          <div className="alert alert-error" role="alert">
            {examError}
          </div>
        )}
        {statusChange.isPending && (
          <div className="alert alert-info" role="status">
            Updating examination status…
          </div>
        )}
        {!exams.data.length ? (
          <EmptyState
            title="No examinations yet"
            detail={
              canCreate
                ? "Create an examination to open a batch for paper scans and marking."
                : "Set up at least one academic year, term, class and subject before creating an exam."
            }
            action={
              !canCreate ? (
                <a className="btn" href="/settings">
                  Open school setup
                </a>
              ) : isExamManager ? (
                <button className="btn primary" onClick={() => setOpen(true)}>
                  Create examination
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="batch-list">
            {exams.data.map((exam) => {
              const count = exam.paper_count || 0;
              const targetStatus = nextStatus[exam.status];
              return (
                <article className="panel batch-card" key={exam.id}>
                  <div className="review-icon">
                    <FileUp size={16} />
                  </div>
                  <div className="batch-card-main">
                    <div className="batch-heading">
                      <h3>{exam.title}</h3>
                      <StatusTag tone={tone(exam.status)}>
                        {exam.status.replace("_", " ")}
                      </StatusTag>
                    </div>
                    <div className="batch-meta">
                      {exam.exam_type} · {exam.max_marks} marks
                      {exam.scheduled_on ? ` · ${exam.scheduled_on}` : ""}
                    </div>
                    <div className="batch-meta">
                      {count} open scan/script record{count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="batch-actions">
                    <button
                      className="btn"
                      onClick={() => setDetailsId(exam.id)}
                    >
                      <Activity size={14} /> Details
                    </button>
                    {canScan && (
                      <button
                        className="btn"
                        onClick={() => {
                          setSelected(exam.id);
                          setUploadMessage("");
                          setUploadError("");
                          document
                            .getElementById("scan-upload")
                            ?.scrollIntoView({
                              behavior: "smooth",
                              block: "center",
                            });
                        }}
                      >
                        Upload scans
                      </button>
                    )}
                    {canScan && (
                      <button
                        className="btn"
                        onClick={() => setOrganizing(exam)}
                      >
                        <Layers3 size={14} /> Organize pages
                      </button>
                    )}
                    {isExamManager &&
                      !["archived", "published"].includes(exam.status) && (
                        <>
                          {exam.status === "draft" && (
                            <button
                              className="linkbtn"
                              disabled={statusChange.isPending}
                              onClick={() =>
                                statusChange.mutate({
                                  id: exam.id,
                                  status: "active",
                                })
                              }
                            >
                              Activate
                            </button>
                          )}
                          {targetStatus && exam.status !== "draft" && (
                            <button
                              className="linkbtn"
                              disabled={statusChange.isPending}
                              onClick={() =>
                                statusChange.mutate({
                                  id: exam.id,
                                  status: targetStatus,
                                })
                              }
                            >
                              {targetStatus === "in_progress"
                                ? "Start marking"
                                : targetStatus === "review"
                                  ? "Move to review"
                                  : targetStatus === "completed"
                                    ? "Complete"
                                    : "Publish"}
                            </button>
                          )}
                          {![
                            "in_progress",
                            "review",
                            "completed",
                            "published",
                          ].includes(exam.status) && (
                            <button
                              className="linkbtn"
                              onClick={() => {
                                setEditing(exam);
                                setExamError("");
                                setOpen(true);
                              }}
                            >
                              <Pencil size={13} /> Edit
                            </button>
                          )}
                        </>
                      )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {exams.data.length > 0 && canScan && (
        <section className="panel pad upload-panel" id="scan-upload">
          <SectionTitle
            eyebrow="PRIVATE PAPER INTAKE"
            title="Upload examination scans"
            detail="Upload protected PDFs and common scan-image files, then manually organize each page into the correct student script."
          />
          <div className="upload-box">
            <label className="label" htmlFor="upload-exam">
              Examination
            </label>
            <select
              className="field"
              id="upload-exam"
              value={selected || exams.data[0]?.id || ""}
              onChange={(event) => {
                setSelected(event.target.value);
                setUploadMessage("");
                setUploadError("");
              }}
            >
              <option value="">Choose an exam</option>
              {exams.data.map((exam) => (
                <option key={exam.id} value={exam.id}>
                  {exam.title}
                </option>
              ))}
            </select>
            <label className="label" htmlFor="scan-files">
              Scan files
            </label>
            <input
              id="scan-files"
              className="field file-field"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/tiff,image/webp,.pdf,.png,.jpg,.jpeg,.tif,.tiff,.webp"
              multiple
              disabled={upload.isPending}
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                chooseFiles(files);
                event.currentTarget.value = "";
              }}
            />
            <input
              ref={cameraInput}
              className="sr-only"
              type="file"
              accept="image/*"
              capture="environment"
              aria-label="Capture a scan with the phone camera"
              disabled={upload.isPending}
              onChange={(event) => {
                chooseFiles(Array.from(event.currentTarget.files || []));
                event.currentTarget.value = "";
              }}
            />
            <div className="upload-foot">
              <span className="muted small">
                Up to 50 files per batch; 20 MB maximum each.
              </span>
              <div className="actions-row">
                <button
                  className="btn"
                  disabled={!selected || upload.isPending}
                  onClick={() => cameraInput.current?.click()}
                >
                  <Search size={14} /> Use phone camera
                </button>
                <button
                  className="btn primary"
                  disabled={!selected || upload.isPending}
                  onClick={() => document.getElementById("scan-files")?.click()}
                >
                  <UploadCloud size={15} />
                  {upload.isPending ? "Uploading…" : "Select scan files"}
                </button>
              </div>
            </div>
          </div>
          {upload.isPending && (
            <div className="upload-progress" role="status" aria-live="polite">
              <div className="progress-track">
                <span style={{ width: `${uploadProgress}%` }} />
              </div>
              <span>Uploading private files… {uploadProgress}%</span>
            </div>
          )}
          {uploadMessage && (
            <div className="alert alert-success">
              <Check size={15} />
              {uploadMessage}
            </div>
          )}
          {uploadError && (
            <div className="alert alert-error" role="alert">
              {uploadError}
            </div>
          )}
        </section>
      )}

      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !save.isPending)
              setOpen(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exam-modal-title"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">EXAMINATION SETUP</div>
                <h2 id="exam-modal-title">
                  {editing ? "Edit exam batch" : "Create exam batch"}
                </h2>
              </div>
              <button
                className="icon-close"
                aria-label="Close"
                disabled={save.isPending}
                onClick={() => setOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <form onSubmit={handleSubmit} noValidate>
              <label className="label" htmlFor="exam-title">
                Exam / subject name
              </label>
              <input
                id="exam-title"
                className="field"
                placeholder="e.g. SS2 Mathematics"
                {...form.register("title")}
              />
              {form.formState.errors.title && (
                <small className="field-error">
                  {form.formState.errors.title.message}
                </small>
              )}
              <div className="form-grid">
                <div>
                  <label className="label" htmlFor="exam-class">
                    Class
                  </label>
                  <select
                    id="exam-class"
                    className="field"
                    {...form.register("class_id")}
                  >
                    <option value="">Choose class</option>
                    {(classes.data || []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  {form.formState.errors.class_id && (
                    <small className="field-error">
                      {form.formState.errors.class_id.message}
                    </small>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="exam-subject">
                    Subject
                  </label>
                  <select
                    id="exam-subject"
                    className="field"
                    {...form.register("subject_id")}
                  >
                    <option value="">Choose subject</option>
                    {(subjects.data || []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-grid">
                <div>
                  <label className="label" htmlFor="exam-year">
                    Academic year
                  </label>
                  <select
                    id="exam-year"
                    className="field"
                    {...form.register("academic_year_id")}
                  >
                    <option value="">Choose year</option>
                    {(years.data || []).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="exam-term">
                    Term
                  </label>
                  <select
                    id="exam-term"
                    className="field"
                    {...form.register("term_id")}
                  >
                    <option value="">Choose term</option>
                    {matchingTerms.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-grid">
                <div>
                  <label className="label" htmlFor="exam-type">
                    Exam type
                  </label>
                  <select
                    id="exam-type"
                    className="field"
                    {...form.register("exam_type")}
                  >
                    <option>Theory</option>
                    <option>Objective</option>
                    <option>Mixed</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="exam-max">
                    Maximum marks
                  </label>
                  <input
                    id="exam-max"
                    className="field"
                    type="number"
                    min="0.01"
                    max="10000"
                    step="0.01"
                    {...form.register("max_marks")}
                  />
                  {form.formState.errors.max_marks && (
                    <small className="field-error">
                      {form.formState.errors.max_marks.message}
                    </small>
                  )}
                </div>
              </div>
              <label className="label" htmlFor="exam-date">
                Scheduled date (optional)
              </label>
              <input
                id="exam-date"
                className="field"
                type="date"
                {...form.register("scheduled_on")}
              />
              {examError && (
                <div className="alert alert-error" role="alert">
                  {examError}
                </div>
              )}
              <div className="form-footer">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="btn primary"
                  disabled={
                    save.isPending ||
                    (editing
                      ? [
                          "in_progress",
                          "review",
                          "completed",
                          "published",
                        ].includes(editing.status)
                      : !canCreate)
                  }
                >
                  {save.isPending
                    ? "Saving…"
                    : editing
                      ? "Save changes"
                      : "Create exam batch"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      {detailsId && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetailsId("");
          }}
        >
          <section
            className="modal exam-detail-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="exam-detail-title"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">ASSESSMENT STATUS</div>
                <h2 id="exam-detail-title">
                  {details.data?.title || "Examination details"}
                </h2>
              </div>
              <button
                className="icon-close"
                aria-label="Close examination details"
                onClick={() => setDetailsId("")}
              >
                <X size={17} />
              </button>
            </div>
            {details.isPending && (
              <Loading label="Loading examination details…" />
            )}
            {details.isError && (
              <ErrorState
                message={details.error.message}
                onRetry={() => void details.refetch()}
              />
            )}
            {details.data && (
              <>
                <div className="exam-summary-grid">
                  <div>
                    <small>Assessment status</small>
                    <StatusTag tone={tone(details.data.status)}>
                      {details.data.status.replace("_", " ")}
                    </StatusTag>
                  </div>
                  <div>
                    <small>Exam type</small>
                    <b>{details.data.exam_type}</b>
                  </div>
                  <div>
                    <small>Maximum marks</small>
                    <b>{details.data.max_marks}</b>
                  </div>
                  <div>
                    <small>Paper records</small>
                    <b>{details.data.papers.length}</b>
                  </div>
                </div>
                <p className="muted small">
                  Updated {new Date(details.data.updated_at).toLocaleString()}.
                  The table shows up to the 200 most recent paper records.
                </p>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>SCAN / SCRIPT</th>
                        <th>STUDENT ASSIGNMENT</th>
                        <th>MARKING STATUS</th>
                        <th>ADDED</th>
                      </tr>
                    </thead>
                    <tbody>
                      {details.data.papers.map((paper) => (
                        <tr key={paper.id}>
                          <td>{paper.file_name}</td>
                          <td>
                            {paper.student_id
                              ? "Assigned — verify in review"
                              : "Unassigned"}
                          </td>
                          <td>
                            <StatusTag tone={tone(paper.status)}>
                              {paper.status.replace("_", " ")}
                            </StatusTag>
                          </td>
                          <td>
                            {new Date(paper.created_at).toLocaleDateString()}
                          </td>
                        </tr>
                      ))}
                      {!details.data.papers.length && (
                        <tr>
                          <td colSpan={4} className="muted">
                            No scan records yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      {organizing && (
        <ScriptOrganizer
          exam={organizing}
          onClose={() => setOrganizing(null)}
        />
      )}
    </>
  );
}
