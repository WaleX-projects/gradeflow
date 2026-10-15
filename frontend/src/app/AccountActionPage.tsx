import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "./auth";
import { api } from "../services/api";

const emailSchema = z.object({
  email: z.string().email("Enter a valid email"),
});
const passwordSchema = z.object({
  password: z.string().min(12, "Use at least 12 characters"),
});
const inviteSchema = z.object({
  full_name: z.string().min(2, "Enter your name"),
  password: z.string().min(12, "Use at least 12 characters"),
});
type EmailForm = z.infer<typeof emailSchema>;
type PasswordForm = z.infer<typeof passwordSchema>;
type InviteForm = z.infer<typeof inviteSchema>;

function ActionFrame({
  eyebrow,
  title,
  detail,
  children,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  children: React.ReactNode;
}) {
  return (
    <main className="account-action-page">
      <Link to="/login" className="brand-lockup action-brand">
        <span className="brand-mark">
          <ShieldCheck size={18} />
        </span>
        <span>
          GradeFlow<small>ASSESSMENT WORKSPACE</small>
        </span>
      </Link>
      <section className="panel account-action-card">
        <div className="metric-icon action-icon">
          <MailCheck size={19} />
        </div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p className="muted">{detail}</p>
        {children}
      </section>
      <Link to="/login" className="return-link">
        <ArrowLeft size={14} /> Return to sign in
      </Link>
    </main>
  );
}

export function AccountActionPage({
  mode,
}: {
  mode: "verify" | "forgot" | "reset" | "resend" | "invite";
}) {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [linkPath, setLinkPath] = useState("");
  const [working, setWorking] = useState(false);
  const ran = useRef(false);
  const navigate = useNavigate();
  const { verifyEmail, acceptInvitation } = useAuth();
  const emailForm = useForm<EmailForm>({ resolver: zodResolver(emailSchema) });
  const passwordForm = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
  });
  const inviteForm = useForm<InviteForm>({
    resolver: zodResolver(inviteSchema),
  });
  useEffect(() => {
    if (mode !== "verify" || ran.current) return;
    ran.current = true;
    if (!token) {
      setError("This verification link is missing its token.");
      return;
    }
    setWorking(true);
    void verifyEmail(token)
      .then(() => navigate("/dashboard", { replace: true }))
      .catch((e: unknown) =>
        setError(
          e instanceof Error
            ? e.message
            : "The verification link could not be used.",
        ),
      )
      .finally(() => setWorking(false));
  }, [mode, token, verifyEmail, navigate]);
  const resend = emailForm.handleSubmit(async ({ email }) => {
    setError("");
    setMessage("");
    setLinkPath("");
    try {
      const endpoint =
        mode === "forgot"
          ? "/auth/forgot-password"
          : "/auth/verify-email/resend";
      const result = await api<{ message: string; reset_path?: string | null }>(
        endpoint,
        { method: "POST", body: JSON.stringify({ email }) },
      );
      setMessage(result.message);
      if (result.reset_path) setLinkPath(result.reset_path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send instructions.");
    }
  });
  const reset = passwordForm.handleSubmit(async ({ password }) => {
    setError("");
    setMessage("");
    try {
      await api<void>("/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({ token, new_password: password }),
      });
      setMessage(
        "Your password has been reset. You can now sign in with the new password.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The password could not be reset.",
      );
    }
  });
  const accept = inviteForm.handleSubmit(async ({ full_name, password }) => {
    setError("");
    setWorking(true);
    try {
      await acceptInvitation({ token, full_name, password });
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The invitation could not be accepted.",
      );
    } finally {
      setWorking(false);
    }
  });
  if (mode === "verify")
    return (
      <ActionFrame
        eyebrow="ONE-TIME EMAIL LINK"
        title={error ? "Verification not complete" : "Verifying email…"}
        detail={
          error ||
          "Confirming this account and creating a secure school session."
        }
      >
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        {working && (
          <div className="state-card">
            <span className="spinner" />
            Checking the one-time link…
          </div>
        )}
        <p className="small muted">
          The link can only be used once and expires after 24 hours.{" "}
          <Link to="/resend-verification">Request a fresh link</Link>
        </p>
      </ActionFrame>
    );
  if (mode === "forgot" || mode === "resend")
    return (
      <ActionFrame
        eyebrow={mode === "forgot" ? "ACCOUNT RECOVERY" : "EMAIL VERIFICATION"}
        title={
          mode === "forgot" ? "Reset your password" : "Resend verification"
        }
        detail={
          mode === "forgot"
            ? "If an account exists for that email, we’ll send a one-time reset link."
            : "Enter your registration email to request another verification link."
        }
      >
        <form onSubmit={resend} noValidate>
          <label className="label" htmlFor="recovery-email">
            Email address
          </label>
          <input
            id="recovery-email"
            className="field"
            type="email"
            autoComplete="email"
            {...emailForm.register("email")}
          />
          {emailForm.formState.errors.email && (
            <small className="field-error">
              {emailForm.formState.errors.email.message}
            </small>
          )}
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="alert alert-success" role="status">
              {message}
            </div>
          )}
          {linkPath && (
            <div className="alert alert-info">
              Development email is not configured.{" "}
              <Link to={linkPath}>Open one-time link</Link>
            </div>
          )}
          <button
            className="btn primary auth-submit"
            disabled={emailForm.formState.isSubmitting}
          >
            {emailForm.formState.isSubmitting
              ? "Sending…"
              : mode === "forgot"
                ? "Send reset instructions"
                : "Send verification link"}
          </button>
        </form>
      </ActionFrame>
    );
  if (mode === "reset")
    return (
      <ActionFrame
        eyebrow="ONE-TIME RESET LINK"
        title="Choose a new password"
        detail="Use a fresh password with at least 12 characters. Reset links expire and can only be used once."
      >
        {!token && (
          <div className="alert alert-error">
            This reset link is missing its token.
          </div>
        )}
        <form onSubmit={reset} noValidate>
          <label className="label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            className="field"
            type="password"
            autoComplete="new-password"
            {...passwordForm.register("password")}
          />
          {passwordForm.formState.errors.password && (
            <small className="field-error">
              {passwordForm.formState.errors.password.message}
            </small>
          )}
          {error && (
            <div className="alert alert-error" role="alert">
              {error}
            </div>
          )}
          {message && (
            <div className="alert alert-success" role="status">
              <CheckCircle2 size={15} />
              {message}
            </div>
          )}
          {message ? (
            <Link className="btn primary auth-submit action-button" to="/login">
              Continue to sign in
            </Link>
          ) : (
            <button
              className="btn primary auth-submit"
              disabled={!token || passwordForm.formState.isSubmitting}
            >
              <KeyRound size={15} /> Reset password
            </button>
          )}
        </form>
      </ActionFrame>
    );
  return (
    <ActionFrame
      eyebrow="SCHOOL STAFF INVITATION"
      title="Join a school workspace"
      detail="Confirm your name and create a password, or enter the password for your existing GradeFlow account to accept the invitation."
    >
      {!token && (
        <div className="alert alert-error">
          This invitation link is missing its token.
        </div>
      )}
      <form onSubmit={accept} noValidate>
        <label className="label" htmlFor="invite-name">
          Your name
        </label>
        <input
          id="invite-name"
          className="field"
          autoComplete="name"
          {...inviteForm.register("full_name")}
        />
        {inviteForm.formState.errors.full_name && (
          <small className="field-error">
            {inviteForm.formState.errors.full_name.message}
          </small>
        )}
        <label className="label" htmlFor="invite-password">
          New password or existing account password
        </label>
        <input
          id="invite-password"
          className="field"
          type="password"
          autoComplete="new-password"
          {...inviteForm.register("password")}
        />
        {inviteForm.formState.errors.password && (
          <small className="field-error">
            {inviteForm.formState.errors.password.message}
          </small>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="btn primary auth-submit"
          disabled={!token || working}
        >
          {working ? "Accepting invitation…" : "Accept school invitation"}
        </button>
      </form>
    </ActionFrame>
  );
}
