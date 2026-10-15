import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { AuthPage } from "./AuthPage";
import { AccountActionPage } from "./AccountActionPage";
import { Workspace } from "./Workspace";

export function App() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="boot-screen">
        <span className="brand-mark">G</span>
        <p>Connecting to your school workspace…</p>
      </div>
    );
  return (
    <Routes>
      <Route
        path="/login"
        element={
          user ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <AuthPage mode="login" />
          )
        }
      />
      <Route
        path="/register"
        element={
          user ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <AuthPage mode="register" />
          )
        }
      />
      <Route path="/verify" element={<AccountActionPage mode="verify" />} />
      <Route
        path="/forgot-password"
        element={<AccountActionPage mode="forgot" />}
      />
      <Route
        path="/reset-password"
        element={<AccountActionPage mode="reset" />}
      />
      <Route
        path="/resend-verification"
        element={<AccountActionPage mode="resend" />}
      />
      <Route
        path="/accept-invite"
        element={<AccountActionPage mode="invite" />}
      />
      <Route
        path="/"
        element={
          user ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/dashboard"
        element={
          user ? (
            <Workspace page="dashboard" />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/batches"
        element={
          user ? <Workspace page="batches" /> : <Navigate to="/login" replace />
        }
      />
      <Route
        path="/review"
        element={
          user ? <Workspace page="review" /> : <Navigate to="/login" replace />
        }
      />
      <Route
        path="/students"
        element={
          user ? (
            <Workspace page="students" />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/results"
        element={
          user ? <Workspace page="results" /> : <Navigate to="/login" replace />
        }
      />
      <Route
        path="/questions"
        element={
          user ? (
            <Workspace page="questions" />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/settings"
        element={
          user ? (
            <Workspace page="settings" />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="*"
        element={<Navigate to={user ? "/dashboard" : "/login"} replace />}
      />
    </Routes>
  );
}
