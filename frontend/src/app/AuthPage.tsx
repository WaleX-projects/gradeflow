import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, BookOpenCheck, ShieldCheck } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./auth";

const loginSchema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});
const registerSchema = z.object({
  full_name: z.string().min(2, "Enter your name"),
  school_name: z.string().min(2, "Enter your school name"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(12, "Use at least 12 characters"),
});
type LoginForm = z.infer<typeof loginSchema>;
type RegisterForm = z.infer<typeof registerSchema>;

function AuthLayout({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-aside">
        <Link to="/login" className="brand-lockup">
          <span className="brand-mark">
            <BookOpenCheck size={21} />
          </span>
          <span>
            GradeFlow<small>ASSESSMENT WORKSPACE</small>
          </span>
        </Link>
        <div className="auth-message">
          <span className="eyebrow">SCHOOL ASSESSMENT, IN GOOD ORDER</span>
          <h1>
            Clear records.
            <br />
            Careful marking.
          </h1>
          <p>
            Organize examinations and review every mark with the evidence in
            view.
          </p>
          <div className="assurance">
            <ShieldCheck size={17} />
            <span>Teacher decisions remain in control.</span>
          </div>
        </div>
        <div className="auth-aside-footer">A calmer way to run assessment.</div>
      </section>
      <section className="auth-form-area">
        <div className="mobile-auth-area">
          <div className="mobile-brand">
            <span className="brand-mark">
              <BookOpenCheck size={18} />
            </span>
            <b>GradeFlow</b>
          </div>
          <div className="auth-form-wrap">
            <div className="eyebrow">{kind}</div>
            {children}
            <div className="auth-footnote">
              Private school records are scoped to your authorized workspace.
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function LoginFormPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    setError("");
    try {
      await login(values);
      navigate("/dashboard", { replace: true });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not connect. Try again.",
      );
    }
  });
  return (
    <>
      <h2>Sign in to GradeFlow</h2>
      <p className="muted">Use your verified school account to continue.</p>
      <form onSubmit={submit} noValidate>
        <label className="label" htmlFor="email">
          Email address
        </label>
        <input
          id="email"
          className="field"
          type="email"
          autoComplete="email"
          {...form.register("email")}
        />
        {form.formState.errors.email && (
          <small className="field-error">
            {form.formState.errors.email.message}
          </small>
        )}
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="field"
          type="password"
          autoComplete="current-password"
          {...form.register("password")}
        />
        {form.formState.errors.password && (
          <small className="field-error">
            {form.formState.errors.password.message}
          </small>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
            {error.toLowerCase().includes("verify") && (
              <>
                {" "}
                ·{" "}
                <Link to="/resend-verification" className="linkbtn">
                  Resend link
                </Link>
              </>
            )}
          </div>
        )}
        <div className="auth-forgot">
          <Link to="/forgot-password">Forgot your password?</Link>
        </div>
        <button
          className="btn primary auth-submit"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting ? "Please wait…" : "Sign in"}
          <ArrowRight size={16} />
        </button>
      </form>
      <div className="auth-switch">
        Setting up a school? <Link to="/register">Create a workspace</Link>
      </div>
    </>
  );
}

function RegisterFormPage() {
  const { register } = useAuth();
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    message: string;
    verification_path?: string | null;
  } | null>(null);
  const form = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
    defaultValues: { full_name: "", school_name: "", email: "", password: "" },
  });
  const submit = form.handleSubmit(async (values) => {
    setError("");
    try {
      const response = await register(values);
      setResult(response);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not create the account. Try again.",
      );
    }
  });
  if (result)
    return (
      <>
        <h2>Check your email</h2>
        <p className="muted">{result.message}</p>
        {result.verification_path && (
          <div className="alert alert-info">
            <span>Local verification link:</span>
            <Link to={result.verification_path}>Verify your email address</Link>
          </div>
        )}
        <p className="muted small">
          Your account is not signed in until the one-time email verification
          step is completed.
        </p>
        <div className="auth-switch">
          <Link to="/login">Return to sign in</Link>
        </div>
      </>
    );
  return (
    <>
      <h2>Set up your school</h2>
      <p className="muted">
        Create an owner account to begin adding real school records.
      </p>
      <form onSubmit={submit} noValidate>
        <label className="label" htmlFor="full_name">
          Your name
        </label>
        <input
          id="full_name"
          className="field"
          autoComplete="name"
          {...form.register("full_name")}
        />
        {form.formState.errors.full_name && (
          <small className="field-error">
            {form.formState.errors.full_name.message}
          </small>
        )}
        <label className="label" htmlFor="school_name">
          School name
        </label>
        <input
          id="school_name"
          className="field"
          autoComplete="organization"
          {...form.register("school_name")}
        />
        {form.formState.errors.school_name && (
          <small className="field-error">
            {form.formState.errors.school_name.message}
          </small>
        )}
        <label className="label" htmlFor="register-email">
          Email address
        </label>
        <input
          id="register-email"
          className="field"
          type="email"
          autoComplete="email"
          {...form.register("email")}
        />
        {form.formState.errors.email && (
          <small className="field-error">
            {form.formState.errors.email.message}
          </small>
        )}
        <label className="label" htmlFor="register-password">
          Password <span className="muted">(at least 12 characters)</span>
        </label>
        <input
          id="register-password"
          className="field"
          type="password"
          autoComplete="new-password"
          {...form.register("password")}
        />
        {form.formState.errors.password && (
          <small className="field-error">
            {form.formState.errors.password.message}
          </small>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="btn primary auth-submit"
          disabled={form.formState.isSubmitting}
        >
          {form.formState.isSubmitting
            ? "Creating…"
            : "Create school workspace"}
          <ArrowRight size={16} />
        </button>
      </form>
      <div className="auth-switch">
        Already have a workspace? <Link to="/login">Sign in</Link>
      </div>
    </>
  );
}

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  return (
    <AuthLayout
      kind={mode === "register" ? "NEW SCHOOL WORKSPACE" : "STAFF SIGN IN"}
    >
      {mode === "register" ? <RegisterFormPage /> : <LoginFormPage />}
    </AuthLayout>
  );
}
