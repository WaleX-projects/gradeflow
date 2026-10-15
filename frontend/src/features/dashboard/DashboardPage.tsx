import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileClock,
  FileText,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../../services/api";
import {
  EmptyState,
  ErrorState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";

type Dashboard = {
  students: number;
  active_exams: number;
  papers_uploaded: number;
  papers_awaiting_review: number;
  completed_jobs: number;
  processing_failures: number;
  organization_name: string;
  recent_activity: {
    id: string;
    action: string;
    entity_type: string;
    created_at: string;
  }[];
};
const iconSet = [
  Users,
  BookOpen,
  FileText,
  FileClock,
  CheckCircle2,
  AlertTriangle,
];

export function DashboardPage() {
  const query = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/dashboard"),
  });
  if (query.isPending) return <Loading label="Loading school activity…" />;
  if (query.isError || !query.data)
    return (
      <ErrorState
        message={query.error?.message || "Dashboard is unavailable."}
        onRetry={() => query.refetch()}
      />
    );
  const d = query.data;
  const metrics = [
    ["Students", d.students, "Active school records"],
    ["Active exams", d.active_exams, "In progress or under review"],
    ["Papers uploaded", d.papers_uploaded, "Private scan records"],
    ["Awaiting review", d.papers_awaiting_review, "Teacher attention required"],
    ["Completed grading jobs", d.completed_jobs, "Worker-confirmed completion"],
    [
      "Processing failures",
      d.processing_failures,
      "Check the processing queue",
    ],
  ] as const;
  const allEmpty = d.students + d.active_exams + d.papers_uploaded === 0;
  return (
    <>
      <section className="dashboard-welcome panel pad">
        <div>
          <span className="eyebrow">SCHOOL WORKSPACE</span>
          <h2>Good to see you, {d.organization_name}</h2>
          <p className="muted">
            Your assessment workspace, backed by records your team has entered.
          </p>
        </div>
        <Link className="btn primary" to="/batches">
          Create an exam batch <span aria-hidden="true">→</span>
        </Link>
      </section>
      <div className="metrics">
        {metrics.map(([label, value, detail], index) => {
          const Icon = iconSet[index];
          return (
            <div className="panel metric-card" key={label}>
              <div className="metric-label">
                <span className="metric-icon">
                  <Icon size={15} />
                </span>
                {label}
              </div>
              <div className="metric-number">{value.toLocaleString()}</div>
              <div className="metric-foot">{detail}</div>
            </div>
          );
        })}
      </div>
      <div className="grid-two">
        <section className="panel pad">
          <SectionTitle
            eyebrow="CURRENT WORK"
            title="Assessment activity"
            detail="Live records, not sample metrics."
          />
          {allEmpty ? (
            <EmptyState
              title="Your school workspace is ready"
              detail="Add an academic year, classes and subjects in School setup, then create an exam. Dashboard totals will appear as your team enters real records."
              action={
                <Link to="/settings" className="btn">
                  Set up academics
                </Link>
              }
            />
          ) : (
            <div className="activity-lines">
              <div className="activity-line">
                <span className="activity-mark" />
                <span>
                  <b>{d.active_exams}</b> active exam
                  {d.active_exams === 1 ? "" : "s"}
                </span>
                <Link to="/batches">View exams</Link>
              </div>
              <div className="activity-line">
                <span className="activity-mark blue-mark" />
                <span>
                  <b>{d.papers_uploaded}</b> private paper
                  {d.papers_uploaded === 1 ? "" : "s"} uploaded
                </span>
                <Link to="/batches">Manage papers</Link>
              </div>
              <div className="activity-line">
                <span className="activity-mark amber-mark" />
                <span>
                  <b>{d.papers_awaiting_review}</b> waiting for teacher review
                </span>
                <Link to="/review">Open queue</Link>
              </div>
            </div>
          )}
        </section>
        <section className="panel pad">
          <SectionTitle
            eyebrow="RECENT CHANGES"
            title="School activity"
            detail="Audit events recorded by the application."
          />
          {d.recent_activity.length ? (
            <ul className="activity-list">
              {d.recent_activity.map((event) => (
                <li key={event.id}>
                  <span className="activity-mark blue-mark" />
                  <div>
                    <b>{event.action.replaceAll(".", " ")}</b>
                    <small>
                      {event.entity_type} ·{" "}
                      {new Date(event.created_at).toLocaleString()}
                    </small>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="quiet-empty">No activity recorded yet.</div>
          )}
        </section>
      </div>
      {d.processing_failures > 0 && (
        <div className="alert alert-error">
          <AlertTriangle size={16} />
          <span>
            {d.processing_failures} job{d.processing_failures === 1 ? "" : "s"}{" "}
            need attention.
          </span>
          <Link to="/review" className="linkbtn">
            Review processing queue
          </Link>
        </div>
      )}
      <section className="panel pad">
        <SectionTitle
          eyebrow="NEXT STEP"
          title="Build a reliable marking workflow"
          detail="Set up classes and subjects before creating exams and uploading papers."
          action={
            <StatusTag tone="blue">
              AI marks always need teacher approval
            </StatusTag>
          }
        />
        <div className="next-step-actions">
          <Link to="/students" className="btn">
            Add students
          </Link>
          <Link to="/questions" className="btn">
            Create a marking scheme
          </Link>
          <Link to="/results" className="btn">
            View results
          </Link>
        </div>
      </section>
    </>
  );
}
