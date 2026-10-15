import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, FileUp, Plus, Search, X } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  api,
  type AcademicItem,
  type Page,
  type Student,
} from "../../services/api";
import {
  EmptyState,
  ErrorState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";

const schema = z
  .object({
    first_name: z.string().trim().min(1, "Enter the first name").max(80),
    last_name: z.string().trim().min(1, "Enter the last name").max(80),
    admission_number: z.string().trim().min(1, "Enter the student ID").max(60),
    class_id: z.string().optional(),
    academic_year_id: z.string().optional(),
  })
  .refine((data) => Boolean(data.class_id) === Boolean(data.academic_year_id), {
    message: "Choose both class and academic year, or leave both blank",
    path: ["class_id"],
  });
type StudentForm = z.infer<typeof schema>;
type ImportResult = {
  id: string;
  file_name: string;
  total_rows: number;
  imported_rows: number;
  failed_rows: number;
  status: string;
  errors: { row: number; issues: { field: string; message: string }[] }[];
};
type ImportBatch = {
  id: string;
  file_name: string;
  status: string;
  total_rows: number;
  imported_rows: number;
  failed_rows: number;
  created_at: string;
};
type StudentHistory = {
  student: Student;
  enrollments: {
    id: string;
    class_id: string;
    class_name: string;
    academic_year_id: string;
    academic_year: string;
    started_at: string;
    ended_at: string | null;
  }[];
  exam_history: {
    exam_id: string;
    title: string;
    status: string;
    score: number;
    max_marks: number;
    updated_at: string;
  }[];
  papers: {
    id: string;
    exam_id: string;
    exam_title: string;
    status: string;
    created_at: string;
  }[];
};

export function StudentsPage() {
  const client = useQueryClient();
  const csvInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [activeFilter, setActiveFilter] = useState("active");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Student | null>(null);
  const [open, setOpen] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [formError, setFormError] = useState("");
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState("");
  const params = new URLSearchParams({
    search,
    page: String(page),
    page_size: "25",
  });
  if (classFilter) params.set("class_id", classFilter);
  if (activeFilter !== "all")
    params.set("is_active", activeFilter === "active" ? "true" : "false");
  const students = useQuery({
    queryKey: ["students", search, classFilter, activeFilter, page],
    queryFn: () => api<Page<Student>>(`/students?${params.toString()}`),
  });
  const classes = useQuery({
    queryKey: ["academics", "classes"],
    queryFn: () => api<AcademicItem[]>("/academics/classes"),
  });
  const years = useQuery({
    queryKey: ["academics", "years"],
    queryFn: () => api<AcademicItem[]>("/academics/years"),
  });
  const history = useQuery({
    queryKey: ["student-profile", profileId],
    queryFn: () => api<StudentHistory>(`/students/${profileId}`),
    enabled: Boolean(profileId),
  });
  const imports = useQuery({
    queryKey: ["student-import-batches"],
    queryFn: () => api<ImportBatch[]>("/students/import-batches"),
  });
  const form = useForm<StudentForm>({
    resolver: zodResolver(schema),
    defaultValues: {
      first_name: "",
      last_name: "",
      admission_number: "",
      class_id: "",
      academic_year_id: "",
    },
  });
  useEffect(() => {
    form.reset(
      editing
        ? {
            first_name: editing.first_name,
            last_name: editing.last_name,
            admission_number: editing.admission_number,
            class_id: "",
            academic_year_id: "",
          }
        : {
            first_name: "",
            last_name: "",
            admission_number: "",
            class_id: "",
            academic_year_id: "",
          },
    );
  }, [editing, form, open]);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["students"] });
    await client.invalidateQueries({ queryKey: ["dashboard"] });
    await client.invalidateQueries({ queryKey: ["student-import-batches"] });
  };
  const save = useMutation({
    mutationFn: (values: StudentForm) => {
      const body = {
        ...values,
        class_id: values.class_id || null,
        academic_year_id: values.academic_year_id || null,
      };
      return editing
        ? api<Student>(`/students/${editing.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              admission_number: body.admission_number,
              first_name: body.first_name,
              last_name: body.last_name,
              is_active: editing.is_active,
            }),
          })
        : api<Student>("/students", {
            method: "POST",
            body: JSON.stringify(body),
          });
    },
    onSuccess: async () => {
      await refresh();
      setOpen(false);
      setEditing(null);
      setFormError("");
    },
  });
  const importMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return api<ImportResult>("/students/import.csv", {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: async (result) => {
      setImportResult(result);
      setImportError("");
      await refresh();
    },
    onError: (error: Error) => setImportError(error.message),
  });
  const submit = form.handleSubmit(async (values) => {
    setFormError("");
    try {
      await save.mutateAsync(values);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Could not save the student.",
      );
    }
  });
  const pagination = useMemo(
    () =>
      students.data
        ? {
            first: students.data.total
              ? (page - 1) * students.data.page_size + 1
              : 0,
            last: Math.min(page * students.data.page_size, students.data.total),
          }
        : { first: 0, last: 0 },
    [students.data, page],
  );
  const showCreate = () => {
    setEditing(null);
    setFormError("");
    setOpen(true);
  };
  const showEdit = (student: Student) => {
    setEditing(student);
    setFormError("");
    setOpen(true);
  };
  const pickCsv = (file?: File) => {
    if (!file) return;
    setImportResult(null);
    setImportError("");
    importMutation.mutate(file);
  };
  if (students.isPending) return <Loading label="Loading student records…" />;
  if (students.isError || !students.data)
    return (
      <ErrorState
        message={students.error?.message || "Student records are unavailable."}
        onRetry={() => void students.refetch()}
      />
    );
  const data = students.data;
  return (
    <>
      <section className="panel pad">
        <SectionTitle
          eyebrow="DIRECTORY"
          title="Student records"
          detail={`${data.total.toLocaleString()} matching student${data.total === 1 ? "" : "s"} in your school workspace.`}
          action={
            <div className="student-actions">
              <button
                className="btn"
                onClick={() => csvInput.current?.click()}
                disabled={importMutation.isPending}
              >
                <FileUp size={15} />
                {importMutation.isPending ? "Importing…" : "Import CSV"}
              </button>
              <button className="btn primary" onClick={showCreate}>
                <Plus size={15} /> Add student
              </button>
            </div>
          }
        />
        <input
          ref={csvInput}
          type="file"
          accept=".csv,text/csv"
          hidden
          aria-label="Choose a student CSV"
          onChange={(event) => {
            pickCsv(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
        <div className="toolbar">
          <div className="search-wrap search-field">
            <Search size={15} />
            <input
              className="field"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search by name or student ID"
              aria-label="Search students"
            />
          </div>
          <label className="filter-select">
            <span className="sr-only">Filter by class</span>
            <select
              className="field"
              value={classFilter}
              onChange={(e) => {
                setClassFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All classes</option>
              {(classes.data || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-select">
            <span className="sr-only">Filter by record status</span>
            <select
              className="field"
              value={activeFilter}
              onChange={(e) => {
                setActiveFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="active">Active records</option>
              <option value="inactive">Inactive records</option>
              <option value="all">All records</option>
            </select>
          </label>
          <span className="muted small">
            Page {data.page} · {data.page_size} per page
          </span>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>STUDENT</th>
                <th>STUDENT ID</th>
                <th>CLASS</th>
                <th>RECORD</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((student) => (
                <tr key={student.id}>
                  <td>
                    <button
                      className="table-primary student-profile-link"
                      onClick={() => setProfileId(student.id)}
                    >
                      {student.first_name} {student.last_name}
                    </button>
                  </td>
                  <td>{student.admission_number}</td>
                  <td>
                    {student.class_name || (
                      <span className="muted">Not enrolled</span>
                    )}
                  </td>
                  <td>
                    <StatusTag tone={student.is_active ? "green" : "neutral"}>
                      {student.is_active ? "Active" : "Inactive"}
                    </StatusTag>
                  </td>
                  <td>
                    <button
                      className="linkbtn"
                      onClick={() => showEdit(student)}
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
              {!data.items.length && (
                <tr>
                  <td colSpan={5}>
                    <EmptyState
                      title={
                        search || classFilter || activeFilter !== "all"
                          ? "No matching students"
                          : "No students added yet"
                      }
                      detail={
                        search || classFilter
                          ? "Adjust your search or filters."
                          : "Add a student record to begin enrolling students and linking scripts to the right person."
                      }
                      action={
                        !search &&
                        !classFilter && (
                          <button className="btn" onClick={showCreate}>
                            Add the first student
                          </button>
                        )
                      }
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="pagination">
          <button
            className="btn"
            disabled={page <= 1}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </button>
          <span>
            {pagination.first}–{pagination.last} of {data.total}
          </span>
          <button
            className="btn"
            disabled={page * data.page_size >= data.total}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      </section>
      <section className="panel pad import-panel">
        <SectionTitle
          eyebrow="BULK INTAKE"
          title="Student CSV imports"
          detail="Upload UTF-8 CSV files up to 5 MB and 5,000 rows. Row errors are recorded without losing valid records."
          action={
            <a
              className="btn"
              href="data:text/csv;charset=utf-8,admission_number%2Cfirst_name%2Clast_name%2Cclass_name%2Cacademic_year%0A"
              download="gradeflow-student-import-template.csv"
            >
              <ArrowDownToLine size={15} /> CSV template
            </a>
          }
        />
        {importMutation.isPending && (
          <div className="alert alert-info" role="status">
            Validating rows and saving the student import batch…
          </div>
        )}
        {importError && (
          <div className="alert alert-error" role="alert">
            {importError}
          </div>
        )}
        {importResult && (
          <div
            className={
              importResult.failed_rows
                ? "alert alert-info"
                : "alert alert-success"
            }
            role="status"
          >
            <b>{importResult.imported_rows}</b> imported ·{" "}
            <b>{importResult.failed_rows}</b> need correction ·{" "}
            {importResult.total_rows} total row
            {importResult.total_rows === 1 ? "" : "s"}
          </div>
        )}
        {importResult?.errors.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>CSV ROW</th>
                  <th>FIELD</th>
                  <th>DETAIL</th>
                </tr>
              </thead>
              <tbody>
                {importResult.errors.flatMap((row) =>
                  row.issues.map((issue, index) => (
                    <tr key={`${row.row}-${issue.field}-${index}`}>
                      <td>{row.row}</td>
                      <td>{issue.field}</td>
                      <td>{issue.message}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        ) : null}
        {imports.data?.length ? (
          <div className="table-wrap import-history">
            <table className="data-table">
              <thead>
                <tr>
                  <th>FILE</th>
                  <th>STATUS</th>
                  <th>IMPORTED</th>
                  <th>ROWS WITH ERRORS</th>
                  <th>DATE</th>
                </tr>
              </thead>
              <tbody>
                {imports.data.slice(0, 20).map((batch) => (
                  <tr key={batch.id}>
                    <td>{batch.file_name}</td>
                    <td>
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
                    </td>
                    <td>
                      {batch.imported_rows}/{batch.total_rows}
                    </td>
                    <td>{batch.failed_rows}</td>
                    <td>{new Date(batch.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">No CSV imports have been recorded.</p>
        )}
      </section>
      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="student-modal-title"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">SCHOOL RECORD</div>
                <h2 id="student-modal-title">
                  {editing ? "Edit student" : "Add student"}
                </h2>
              </div>
              <button
                className="icon-close"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <form onSubmit={submit} noValidate>
              <div className="form-grid">
                <div>
                  <label className="label" htmlFor="student-first">
                    First name
                  </label>
                  <input
                    id="student-first"
                    autoComplete="given-name"
                    className="field"
                    {...form.register("first_name")}
                  />
                  {form.formState.errors.first_name && (
                    <small className="field-error">
                      {form.formState.errors.first_name.message}
                    </small>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="student-last">
                    Last name
                  </label>
                  <input
                    id="student-last"
                    autoComplete="family-name"
                    className="field"
                    {...form.register("last_name")}
                  />
                  {form.formState.errors.last_name && (
                    <small className="field-error">
                      {form.formState.errors.last_name.message}
                    </small>
                  )}
                </div>
              </div>
              <label className="label" htmlFor="student-id">
                Admission / student ID
              </label>
              <input
                id="student-id"
                className="field"
                {...form.register("admission_number")}
              />
              {form.formState.errors.admission_number && (
                <small className="field-error">
                  {form.formState.errors.admission_number.message}
                </small>
              )}
              {!editing && (
                <>
                  <div className="form-grid">
                    <div>
                      <label className="label" htmlFor="student-class">
                        Class (optional)
                      </label>
                      <select
                        id="student-class"
                        className="field"
                        {...form.register("class_id")}
                      >
                        <option value="">Not enrolled yet</option>
                        {(classes.data || []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="label" htmlFor="student-year">
                        Academic year (optional)
                      </label>
                      <select
                        id="student-year"
                        className="field"
                        {...form.register("academic_year_id")}
                      >
                        <option value="">Not enrolled yet</option>
                        {(years.data || []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <p className="muted small">
                    Choose both class and academic year to enroll now; leave
                    both blank to add the record only.
                  </p>
                </>
              )}
              {editing && (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={editing.is_active}
                    onChange={(event) =>
                      setEditing({
                        ...editing,
                        is_active: event.target.checked,
                      })
                    }
                  />{" "}
                  Student record is active
                </label>
              )}
              {form.formState.errors.class_id && (
                <div className="field-error">
                  {form.formState.errors.class_id.message}
                </div>
              )}
              {formError && (
                <div className="alert alert-error" role="alert">
                  {formError}
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
                <button className="btn primary" disabled={save.isPending}>
                  {save.isPending
                    ? "Saving…"
                    : editing
                      ? "Save changes"
                      : "Create student"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
      {profileId && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setProfileId("");
          }}
        >
          <section
            className="modal student-profile-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="student-profile-title"
          >
            <div className="modal-header">
              <div>
                <div className="eyebrow">STUDENT PROFILE</div>
                <h2 id="student-profile-title">
                  {history.data
                    ? `${history.data.student.first_name} ${history.data.student.last_name}`
                    : "Student history"}
                </h2>
              </div>
              <button
                className="icon-close"
                aria-label="Close student profile"
                onClick={() => setProfileId("")}
              >
                <X size={17} />
              </button>
            </div>
            {history.isPending && <Loading label="Loading school history…" />}
            {history.isError && (
              <ErrorState
                message={history.error.message}
                onRetry={() => void history.refetch()}
              />
            )}
            {history.data && (
              <>
                <p className="muted small">
                  Admission number:{" "}
                  <b>{history.data.student.admission_number}</b>
                </p>
                <h3>Class enrollment history</h3>
                <div className="student-history-list">
                  {history.data.enrollments.map((row) => (
                    <div key={row.id}>
                      <b>
                        {row.class_name} · {row.academic_year}
                      </b>
                      <span>
                        {new Date(row.started_at).toLocaleDateString()} —{" "}
                        {row.ended_at
                          ? new Date(row.ended_at).toLocaleDateString()
                          : "Current"}
                      </span>
                    </div>
                  ))}
                  {!history.data.enrollments.length && (
                    <p className="muted small">
                      No enrollments have been recorded.
                    </p>
                  )}
                </div>
                <h3>Examination results</h3>
                <div className="student-history-list">
                  {history.data.exam_history.map((row) => (
                    <div key={row.exam_id}>
                      <b>{row.title}</b>
                      <span>
                        {row.status} · {row.score}/{row.max_marks}
                      </span>
                    </div>
                  ))}
                  {!history.data.exam_history.length && (
                    <p className="muted small">
                      No teacher-finalized exam results are recorded.
                    </p>
                  )}
                </div>
                <h3>Examination scripts</h3>
                <div className="student-history-list">
                  {history.data.papers.map((row) => (
                    <div key={row.id}>
                      <b>{row.exam_title}</b>
                      <span>
                        {row.status} ·{" "}
                        {new Date(row.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                  {!history.data.papers.length && (
                    <p className="muted small">
                      No examination scripts are assigned to this student.
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
