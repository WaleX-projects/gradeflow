import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";

export function Loading({ label = "Loading records…" }: { label?: string }) {
  return (
    <div className="state-card" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="alert alert-error" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
      {onRetry && (
        <button className="linkbtn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Info size={18} />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function StatusTag({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "green" | "amber" | "red" | "blue" | "neutral";
}) {
  return (
    <span className={`tag ${tone}`}>
      <span className="tag-dot" />
      {children}
    </span>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  return (
    <div className="alert alert-success" role="status">
      <CheckCircle2 size={16} />
      {children}
    </div>
  );
}

export function SectionTitle({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-title-row">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h2>{title}</h2>
        {detail && <p className="muted">{detail}</p>}
      </div>
      {action}
    </div>
  );
}
