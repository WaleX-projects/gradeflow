import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Layers3,
  Minus,
  Plus,
  RotateCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  api,
  type Exam,
  type Page,
  type Student,
  type UnorganizedPage,
  type UploadBatch,
} from "../../services/api";
import { ErrorState, Loading, StatusTag } from "../../components/ui";

type DraftGroup = {
  key: string;
  student_id: string | null;
  pageIds: string[];
  pages: UnorganizedPage[];
};

type Props = { exam: Exam; onClose: () => void };

export function ScriptOrganizer({ exam, onClose }: Props) {
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [studentSearch, setStudentSearch] = useState("");
  const [studentId, setStudentId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<DraftGroup[]>([]);
  const pages = useQuery({
    queryKey: ["organize-pages", exam.id, page],
    queryFn: () =>
      api<Page<UnorganizedPage>>(
        `/exams/${exam.id}/unorganized-pages?page=${page}&page_size=40`,
      ),
  });
  const students = useQuery({
    queryKey: [
      "organize-students",
      exam.class_id,
      exam.academic_year_id,
      studentSearch,
    ],
    queryFn: () => {
      const query = new URLSearchParams({
        class_id: exam.class_id,
        academic_year_id: exam.academic_year_id,
        is_active: "true",
        page: "1",
        page_size: "50",
        search: studentSearch,
      });
      return api<Page<Student>>(`/students?${query.toString()}`);
    },
  });
  const batches = useQuery({
    queryKey: ["upload-batches", exam.id],
    queryFn: () => api<UploadBatch[]>(`/upload-batches?exam_id=${exam.id}`),
  });
  const organize = useMutation({
    mutationFn: () =>
      api<{
        pages_organized: number;
        scripts: {
          id: string;
          page_count: number;
          student_id: string | null;
        }[];
      }>("/papers/organize", {
        method: "POST",
        body: JSON.stringify({
          exam_id: exam.id,
          groups: groups.map((group) => ({
            student_id: group.student_id,
            page_ids: group.pageIds,
          })),
        }),
      }),
    onSuccess: async (result) => {
      setGroups([]);
      setSelectedIds(new Set());
      setPage(1);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["organize-pages", exam.id] }),
        client.invalidateQueries({ queryKey: ["papers"] }),
        client.invalidateQueries({ queryKey: ["dashboard"] }),
        client.invalidateQueries({ queryKey: ["exams"] }),
      ]);
      setSuccess(
        `${result.pages_organized} page${result.pages_organized === 1 ? "" : "s"} organized into ${result.scripts.length} script${result.scripts.length === 1 ? "" : "s"}. Unassigned scripts remain unassigned.`,
      );
    },
  });
  const [success, setSuccess] = useState("");
  const pageRows = pages.data?.items || [];
  const assigned = useMemo(
    () => new Set(groups.flatMap((group) => group.pageIds)),
    [groups],
  );
  const selectedRows = useMemo(
    () =>
      pageRows.filter(
        (item) => selectedIds.has(item.id) && !assigned.has(item.id),
      ),
    [pageRows, selectedIds, assigned],
  );
  const knownStudents = students.data?.items || [];
  const usedStudentIds = new Set(
    groups.flatMap((group) => (group.student_id ? [group.student_id] : [])),
  );
  const pageCount = pages.data
    ? Math.max(1, Math.ceil(pages.data.total / pages.data.page_size))
    : 1;

  const addGroup = () => {
    if (!selectedRows.length) return;
    setGroups((previous) => [
      ...previous,
      {
        key: crypto.randomUUID(),
        student_id: studentId || null,
        pageIds: selectedRows.map((row) => row.id),
        pages: selectedRows,
      },
    ]);
    setSelectedIds(
      (previous) =>
        new Set(
          [...previous].filter(
            (id) => !selectedRows.some((row) => row.id === id),
          ),
        ),
    );
    setStudentId("");
    setSuccess("");
  };

  const togglePage = (id: string) =>
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !organize.isPending)
          onClose();
      }}
    >
      <section
        className="modal organizer-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="organizer-title"
      >
        <div className="modal-header">
          <div>
            <div className="eyebrow">TEACHER-ASSIGNED PAGES</div>
            <h2 id="organizer-title">Organize examination scripts</h2>
            <p className="muted small">
              {exam.title} · {exam.max_marks} maximum marks
            </p>
          </div>
          <button
            className="icon-close"
            aria-label="Close page organizer"
            disabled={organize.isPending}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <div className="alert alert-info">
          <ShieldCheck size={16} />
          <span>
            Student identity is never guessed from handwriting. Select each page
            and assign it only when you have verified the student; unassigned
            scripts can be saved for later.
          </span>
        </div>

        <section
          className="organizer-section"
          aria-label="Pages awaiting organization"
        >
          <div className="section-mini-heading">
            <h3>Unorganized scan pages</h3>
            <span className="muted small">
              {pages.data?.total ?? "…"} remaining · 40 per page
            </span>
          </div>
          {pages.isPending && (
            <Loading label="Loading authenticated scan pages…" />
          )}
          {pages.isError && (
            <ErrorState
              message={pages.error.message}
              onRetry={() => void pages.refetch()}
            />
          )}
          {pages.data && !pages.data.total && (
            <div className="empty-inline">
              <b>All uploaded pages are organized.</b>
              <p className="muted small">
                New batch-uploaded pages will appear here.
              </p>
            </div>
          )}
          {pages.data && pages.data.total > 0 && (
            <>
              <div className="organizer-page-grid">
                {pageRows.map((item) => {
                  const isAssigned = assigned.has(item.id);
                  return (
                    <label
                      className={`organizer-page ${isAssigned ? "grouped" : ""} ${selectedIds.has(item.id) ? "selected" : ""}`}
                      key={item.id}
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        disabled={isAssigned || organize.isPending}
                        onChange={() => togglePage(item.id)}
                        aria-label={`Select original scan page ${item.source_page_number} from ${item.file_name}`}
                      />
                      <img
                        loading="lazy"
                        src={`/api/v1/papers/${item.paper_id}/pages/${item.id}/preview`}
                        alt={`Private preview: ${item.file_name}, original page ${item.source_page_number}`}
                      />
                      <span className="organizer-page-meta">
                        <b>Original page {item.source_page_number}</b>
                        <small>{item.file_name}</small>
                        {isAssigned && (
                          <small>
                            In script group{" "}
                            {groups.findIndex((group) =>
                              group.pageIds.includes(item.id),
                            ) + 1}
                          </small>
                        )}
                      </span>
                      {item.flagged && (
                        <StatusTag tone="amber">Flagged</StatusTag>
                      )}
                    </label>
                  );
                })}
              </div>
              <div className="pagination">
                <button
                  className="btn"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ArrowLeft size={14} /> Previous
                </button>
                <span>
                  Page {pages.data.page} of {pageCount}
                </span>
                <button
                  className="btn"
                  disabled={page >= pageCount}
                  onClick={() =>
                    setPage((current) => Math.min(pageCount, current + 1))
                  }
                >
                  Next <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}
        </section>

        <section
          className="organizer-section"
          aria-label="Build student scripts"
        >
          <div className="section-mini-heading">
            <h3>Build a student script</h3>
            <span className="muted small">{selectedIds.size} selected</span>
          </div>
          <div className="organizer-build-row">
            <label className="organizer-student">
              <span className="label">Verified student · optional</span>
              <input
                className="field"
                type="search"
                value={studentSearch}
                onChange={(event) => setStudentSearch(event.target.value)}
                placeholder="Find a student in this class"
                aria-label="Search enrolled students"
              />
              <select
                className="field"
                value={studentId}
                onChange={(event) => setStudentId(event.target.value)}
                aria-label="Assign selected pages to a verified student"
              >
                <option value="">Leave student unassigned</option>
                {knownStudents.map((student) => (
                  <option
                    key={student.id}
                    value={student.id}
                    disabled={usedStudentIds.has(student.id)}
                  >
                    {student.first_name} {student.last_name} ·{" "}
                    {student.admission_number}
                    {usedStudentIds.has(student.id) ? " · already grouped" : ""}
                  </option>
                ))}
              </select>
              <small className="muted">
                {students.data?.total ?? 0} active enrollment(s) in this exam
                class and year.
              </small>
            </label>
            <button
              className="btn primary"
              disabled={!selectedRows.length || organize.isPending}
              onClick={addGroup}
            >
              <Plus size={14} /> Add selected pages
            </button>
          </div>
          {selectedIds.size > 0 && selectedRows.length === 0 && (
            <p className="field-error">
              Selected pages are already in another script group. Remove them
              from that group before reassignment.
            </p>
          )}
          {groups.length > 0 && (
            <div className="draft-groups">
              <b>Script groups to save ({groups.length})</b>
              {groups.map((group, index) => {
                const student = knownStudents.find(
                  (row) => row.id === group.student_id,
                );
                return (
                  <div className="draft-group" key={group.key}>
                    <div>
                      <b>Script {index + 1}</b>
                      <span>
                        {student
                          ? `${student.first_name} ${student.last_name} · ${student.admission_number}`
                          : "Unassigned — confirm identity in the review queue"}
                      </span>
                      <small>
                        {group.pages.length} page(s):{" "}
                        {group.pages
                          .map(
                            (row) =>
                              `${row.file_name} / p. ${row.source_page_number}`,
                          )
                          .join(" · ")}
                      </small>
                    </div>
                    <button
                      className="btn"
                      onClick={() =>
                        setGroups((previous) =>
                          previous.filter((item) => item.key !== group.key),
                        )
                      }
                      aria-label={`Remove script group ${index + 1}`}
                    >
                      <Minus size={14} /> Remove
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {batches.data?.length ? (
          <section className="organizer-section">
            <div className="section-mini-heading">
              <h3>Recent upload batches</h3>
              <span className="muted small">Persisted intake outcomes</span>
            </div>
            {batches.data.slice(0, 5).map((batch) => (
              <div className="upload-batch-row" key={batch.id}>
                <div>
                  <b>
                    {batch.accepted_files}/{batch.total_files} accepted
                  </b>
                  <small>{new Date(batch.created_at).toLocaleString()}</small>
                </div>
                <StatusTag
                  tone={
                    batch.status === "completed"
                      ? "green"
                      : batch.status === "partial"
                        ? "amber"
                        : "red"
                  }
                >
                  {batch.status}
                </StatusTag>
                {batch.rejected_files > 0 && (
                  <details>
                    <summary>{batch.rejected_files} rejected</summary>
                    <ul>
                      {batch.errors.map((error, index) => (
                        <li key={`${error.file_name}-${index}`}>
                          {error.file_name}: {error.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </section>
        ) : null}
        {success && (
          <div className="alert alert-success" role="status">
            <RotateCw size={15} />
            {success}
          </div>
        )}
        {organize.isError && (
          <div className="alert alert-error" role="alert">
            {organize.error.message}
          </div>
        )}
        <div className="form-footer">
          <span className="muted small">
            Page order follows your selection; use the review queue to reorder
            pages.
          </span>
          <button
            className="btn primary"
            disabled={!groups.length || organize.isPending}
            onClick={() => organize.mutate()}
          >
            <Layers3 size={15} />
            {organize.isPending
              ? "Building private scripts…"
              : `Save ${groups.length} script group${groups.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </section>
    </div>
  );
}
