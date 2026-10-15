import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenCheck,
  ChevronRight,
  ClipboardList,
  FileCheck2,
  FileText,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Users,
  X,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../app/auth";
import { api } from "../services/api";

const nav = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/batches", label: "Exam batches", icon: ClipboardList },
  { to: "/review", label: "Marking & review", icon: FileCheck2 },
  { to: "/students", label: "Students", icon: Users },
  { to: "/results", label: "Results", icon: GraduationCap },
];
const manage = [
  { to: "/questions", label: "Marking scheme", icon: FileText },
  { to: "/settings", label: "School setup", icon: Settings },
];
const titleMap: Record<string, string> = {
  "/dashboard": "Assessment overview",
  "/batches": "Exam batches",
  "/review": "Marking & review",
  "/students": "Student records",
  "/results": "Results register",
  "/questions": "Marking scheme",
  "/settings": "School setup",
};
type WorkspaceChoice = {
  id: string;
  name: string;
  role: string;
  active: boolean;
};

type WorkspaceUser = {
  id: string;
  email: string;
  full_name: string;
  role: string;
  organization_id: string;
  organization_name: string;
};

export function WorkspaceShell({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const client = useQueryClient();
  const choices = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api<WorkspaceChoice[]>("/auth/workspaces"),
    enabled: Boolean(user),
  });
  const changeWorkspace = useMutation({
    mutationFn: (organizationId: string) =>
      api<WorkspaceUser>(`/auth/workspaces/${organizationId}/select`, {
        method: "POST",
      }),
    onSuccess: (next) => {
      client.clear();
      client.setQueryData(["me"], next);
      setSwitchError("");
      navigate("/dashboard", { replace: true });
    },
    onError: (error: Error) => setSwitchError(error.message),
  });
  const title = titleMap[path] || "Assessment workspace";
  const initial = (user?.full_name || "G")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };
  const canCreateExam = ["owner", "school_admin", "exam_officer"].includes(
    user?.role || "",
  );
  return (
    <div className="app-layout">
      <header className="mobile-topbar">
        <button
          className="icon-button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
        <Link to="/dashboard" className="brand-lockup">
          <span className="brand-mark">
            <BookOpenCheck size={18} />
          </span>
          <b>GradeFlow</b>
        </Link>
        <span className="mobile-top-spacer" />
      </header>
      {open && (
        <button
          className="mobile-scrim"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <Link to="/dashboard" className="brand-lockup sidebar-brand">
          <span className="brand-mark">
            <BookOpenCheck size={19} />
          </span>
          <span>
            GradeFlow<small>ASSESSMENT WORKSPACE</small>
          </span>
        </Link>
        <div className="side-label">WORKSPACE</div>
        <nav aria-label="Workspace navigation">
          {nav.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setOpen(false)}
              className={`nav-link ${path === to ? "active" : ""}`}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
              {path === to && (
                <ChevronRight className="nav-current" size={15} />
              )}
            </Link>
          ))}
        </nav>
        <div className="side-label manage-label">MANAGE</div>
        <nav aria-label="School management">
          {manage.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              onClick={() => setOpen(false)}
              className={`nav-link ${path === to ? "active" : ""}`}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="workspace-school">
          <span className="school-mark">
            {(user?.organization_name || "S").slice(0, 1).toUpperCase()}
          </span>
          <div className="school-name">
            <span>{user?.organization_name}</span>
            <small>{user?.role?.replaceAll("_", " ")}</small>
          </div>
        </div>
        {choices.data && choices.data.length > 1 && (
          <label className="workspace-switch-label">
            <span>SWITCH SCHOOL</span>
            <select
              className="workspace-switch"
              aria-label="Select school workspace"
              value={user?.organization_id || ""}
              disabled={changeWorkspace.isPending}
              onChange={(event) =>
                changeWorkspace.mutate(event.currentTarget.value)
              }
            >
              {choices.data.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name} · {choice.role.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
        )}
        {switchError && (
          <div className="workspace-switch-error" role="alert">
            {switchError}
          </div>
        )}
        <div className="profile-row">
          <span className="avatar">{initial}</span>
          <span className="profile-name">
            {user?.full_name}
            <small>{user?.email}</small>
          </span>
          <button
            className="icon-button logout-button"
            onClick={onLogout}
            title="Sign out"
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="main-canvas">
        <header className="page-header">
          <div>
            <div className="crumb">
              {user?.organization_name} <span>/</span> <span>{title}</span>
            </div>
            <h1>{title}</h1>
          </div>
          {canCreateExam && (
            <button
              className="btn primary header-action"
              onClick={() => navigate("/batches")}
            >
              <span aria-hidden="true">＋</span> New exam batch
            </button>
          )}
        </header>
        <div className="page-content">{children}</div>
        <footer className="app-footer">
          <span>GradeFlow Assessment Workspace</span>
          <span>Teacher review required before grades are finalized.</span>
        </footer>
      </main>
    </div>
  );
}
