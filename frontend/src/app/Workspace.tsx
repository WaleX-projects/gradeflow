import type { ReactNode } from "react";
import { WorkspaceShell } from "../components/WorkspaceShell";
import { DashboardPage } from "../features/dashboard/DashboardPage";
import { StudentsPage } from "../features/students/StudentsPage";
import { ExamsPage } from "../features/exams/ExamsPage";
import { ReviewPage } from "../features/review/ReviewPage";
import { ResultsPage } from "../features/results/ResultsPage";
import { RubricPage } from "../features/exams/RubricPage";
import { SettingsPage } from "../features/settings/SettingsPage";

const pages: Record<string, ReactNode> = {
  dashboard: <DashboardPage />,
  batches: <ExamsPage />,
  review: <ReviewPage />,
  students: <StudentsPage />,
  results: <ResultsPage />,
  questions: <RubricPage />,
  settings: <SettingsPage />,
};
const paths: Record<string, string> = {
  dashboard: "/dashboard",
  batches: "/batches",
  review: "/review",
  students: "/students",
  results: "/results",
  questions: "/questions",
  settings: "/settings",
};

export function Workspace({ page }: { page: keyof typeof pages }) {
  return <WorkspaceShell path={paths[page]}>{pages[page]}</WorkspaceShell>;
}
