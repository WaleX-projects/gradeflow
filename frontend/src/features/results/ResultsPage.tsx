import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Megaphone } from "lucide-react";
import { api, type Exam } from "../../services/api";
import { useAuth } from "../../app/auth";
import {
  EmptyState,
  ErrorState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";

type Result = {
  exam_id: string;
  student_id: string;
  student_name: string;
  admission_number: string;
  total_score: number;
  max_marks: number;
  status: string;
};

async function downloadResults(format: "csv" | "xlsx", examId: string) {
  const query = examId ? `?exam_id=${encodeURIComponent(examId)}` : "";
  const response = await fetch(`/api/v1/results/export.${format}${query}`, {
    credentials: "include",
  });
  if (!response.ok)
    throw new Error(`Unable to export results (${response.status}).`);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `gradeflow-results.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ResultsPage() {
  const client = useQueryClient();
  const { user } = useAuth();
  const [examId, setExamId] = useState("");
  const [notice, setNotice] = useState("");
  const exams = useQuery({
    queryKey: ["exams"],
    queryFn: () => api<Exam[]>("/exams"),
  });
  const results = useQuery({
    queryKey: ["results", examId],
    queryFn: () =>
      api<Result[]>(
        `/results${examId ? `?exam_id=${encodeURIComponent(examId)}` : ""}`,
      ),
  });
  const canPublish = ["owner", "school_admin", "exam_officer"].includes(
    user?.role || "",
  );
  const publish = useMutation({
    mutationFn: ({ exam, student }: { exam: string; student: string }) =>
      api(`/results/${exam}/${student}/publish`, { method: "POST" }),
    onSuccess: async () => {
      setNotice(
        "Teacher-finalized result published. The action has been recorded in the school audit trail.",
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ["results"] }),
        client.invalidateQueries({ queryKey: ["audit"] }),
      ]);
    },
  });
  const [exportError, setExportError] = useState("");
  const performExport = async (format: "csv" | "xlsx") => {
    setExportError("");
    try {
      await downloadResults(format, examId);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    }
  };
  if (exams.isPending || results.isPending)
    return <Loading label="Loading confirmed results…" />;
  if (exams.isError || results.isError)
    return (
      <ErrorState
        message={
          results.error?.message ||
          exams.error?.message ||
          "Results are unavailable."
        }
        onRetry={() => void results.refetch()}
      />
    );
  const rows = results.data || [];

  return (
    <section className="panel pad">
      <SectionTitle
        eyebrow="SERVER-CALCULATED TOTALS"
        title="Results register"
        detail="Only teacher-confirmed scores are included. AI proposals are never final results."
        action={
          <div className="actions-row">
            <button
              className="btn"
              onClick={() => void performExport("csv")}
              disabled={!rows.length}
            >
              <Download size={14} /> Export CSV
            </button>
            <button
              className="btn"
              onClick={() => void performExport("xlsx")}
              disabled={!rows.length}
            >
              <FileSpreadsheet size={14} /> Export XLSX
            </button>
          </div>
        }
      />
      <label className="label" htmlFor="results-exam">
        Filter examination
      </label>
      <select
        className="field exam-select"
        id="results-exam"
        value={examId}
        onChange={(event) => {
          setExamId(event.target.value);
          setNotice("");
        }}
      >
        <option value="">All examinations</option>
        {(exams.data || []).map((exam) => (
          <option key={exam.id} value={exam.id}>
            {exam.title}
          </option>
        ))}
      </select>
      {notice && (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      )}
      {publish.isError && (
        <div className="alert alert-error" role="alert">
          {publish.error.message}
        </div>
      )}
      {exportError && (
        <div className="alert alert-error" role="alert">
          {exportError}
        </div>
      )}
      <div className="results-summary">
        <span>
          <FileSpreadsheet size={17} /> <b>{rows.length}</b> stored result
          {rows.length === 1 ? "" : "s"}
        </span>
        <span className="muted small">
          Final totals and publication state come from the server.
        </span>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>STUDENT</th>
              <th>ADMISSION NUMBER</th>
              <th>TEACHER-CONFIRMED TOTAL</th>
              <th>MAXIMUM</th>
              <th>PUBLICATION</th>
              {canPublish && <th>ACTION</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((result) => (
              <tr key={`${result.exam_id}:${result.student_id}`}>
                <td>
                  <span className="table-primary">{result.student_name}</span>
                </td>
                <td>{result.admission_number}</td>
                <td>
                  <b>{result.total_score}</b>
                </td>
                <td>{result.max_marks}</td>
                <td>
                  <StatusTag
                    tone={result.status === "published" ? "green" : "blue"}
                  >
                    {result.status.replace("_", " ")}
                  </StatusTag>
                </td>
                {canPublish && (
                  <td>
                    {result.status === "published" ? (
                      <span className="muted small">Published</span>
                    ) : (
                      <button
                        className="btn primary"
                        disabled={publish.isPending}
                        onClick={() => {
                          setNotice("");
                          publish.mutate({
                            exam: result.exam_id,
                            student: result.student_id,
                          });
                        }}
                      >
                        <Megaphone size={14} /> Publish result
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <EmptyState
          title="No confirmed results yet"
          detail="Results appear after a teacher confirms every question mark for an assigned script. AI suggestions alone do not create final totals."
        />
      )}
      {canPublish && rows.some((row) => row.status === "finalized") && (
        <p className="muted small results-publish-note">
          Publishing is per student; only teacher-finalized records can be
          published. Editing a previously published mark returns the result to
          finalized and requires review before republication.
        </p>
      )}
    </section>
  );
}
