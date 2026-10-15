import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CalendarDays,
  KeyRound,
  Layers3,
  MailPlus,
  Shield,
  Users,
} from "lucide-react";
import { useAuth } from "../../app/auth";
import { api, type AcademicItem } from "../../services/api";
import {
  ErrorState,
  Loading,
  SectionTitle,
  StatusTag,
} from "../../components/ui";

type StaffMember = {
  membership_id: string;
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  is_email_verified: boolean;
  joined_at: string;
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
  expired: boolean;
};
type SessionRecord = {
  id: string;
  created_at: string;
  expires_at: string;
  current: boolean;
};
type Organization = { id: string; name: string; role: string };
type InviteCreated = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  invitation_path?: string | null;
  message: string;
};
type AuditEvent = {
  id: string;
  action: string;
  entity_type: string;
  entity_id?: string | null;
  actor_user_id?: string | null;
  created_at: string;
};
const inviteRoles = [
  "school_admin",
  "exam_officer",
  "teacher_marker",
  "reviewer",
  "viewer",
];
const roleLabels: Record<string, string> = {
  owner: "Owner",
  school_admin: "School administrator",
  exam_officer: "Exam officer",
  teacher_marker: "Teacher / marker",
  reviewer: "Reviewer",
  viewer: "Viewer",
};

export function SettingsPage() {
  const { user, updateProfile } = useAuth();
  const client = useQueryClient();
  const isAdmin = ["owner", "school_admin"].includes(user?.role || "");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [fullName, setFullName] = useState(user?.full_name || "");
  const [orgName, setOrgName] = useState(user?.organization_name || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("teacher_marker");
  const [createdInvite, setCreatedInvite] = useState<InviteCreated | null>(
    null,
  );
  useEffect(() => {
    setFullName(user?.full_name || "");
    setOrgName(user?.organization_name || "");
  }, [user?.full_name, user?.organization_name]);
  const years = useQuery({
    queryKey: ["academics", "years"],
    queryFn: () => api<AcademicItem[]>("/academics/years"),
  });
  const terms = useQuery({
    queryKey: ["academics", "terms"],
    queryFn: () => api<AcademicItem[]>("/academics/terms"),
  });
  const classes = useQuery({
    queryKey: ["academics", "classes"],
    queryFn: () => api<AcademicItem[]>("/academics/classes"),
  });
  const subjects = useQuery({
    queryKey: ["academics", "subjects"],
    queryFn: () => api<AcademicItem[]>("/academics/subjects"),
  });
  const organization = useQuery({
    queryKey: ["organization"],
    queryFn: () => api<Organization>("/organization"),
  });
  const staff = useQuery({
    queryKey: ["staff"],
    queryFn: () => api<StaffMember[]>("/staff"),
    enabled: isAdmin,
  });
  const invitations = useQuery({
    queryKey: ["staff-invitations"],
    queryFn: () => api<Invitation[]>("/staff/invitations"),
    enabled: isAdmin,
  });
  const sessions = useQuery({
    queryKey: ["auth-sessions"],
    queryFn: () => api<SessionRecord[]>("/auth/sessions"),
  });
  const canReadAudit = ["owner", "school_admin", "reviewer"].includes(
    user?.role || "",
  );
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: () => api<AuditEvent[]>("/audit?page=1"),
    enabled: canReadAudit,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ["organization"] }),
      client.invalidateQueries({ queryKey: ["staff"] }),
      client.invalidateQueries({ queryKey: ["staff-invitations"] }),
      client.invalidateQueries({ queryKey: ["academics"] }),
      client.invalidateQueries({ queryKey: ["dashboard"] }),
      client.invalidateQueries({ queryKey: ["me"] }),
      client.invalidateQueries({ queryKey: ["auth-sessions"] }),
    ]);
  };
  const academicSave = useMutation({
    mutationFn: async ({
      kind,
      data,
    }: {
      kind: string;
      data: Record<string, unknown>;
    }) => {
      const endpoints: Record<string, string> = {
        year: "/academics/years",
        term: "/academics/terms",
        class: "/academics/classes",
        subject: "/academics/subjects",
      };
      return api(endpoints[kind], {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
    onSuccess: async (_result, vars) => {
      setError("");
      setFeedback(
        `${vars.kind === "year" ? "Academic year" : vars.kind === "term" ? "Term" : vars.kind === "class" ? "Class" : "Subject"} saved.`,
      );
      await client.invalidateQueries({ queryKey: ["academics"] });
      await client.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  const profileSave = useMutation({
    mutationFn: () => updateProfile(fullName.trim()),
    onSuccess: async () => {
      setFeedback("Profile updated.");
      setError("");
      await client.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const organizationSave = useMutation({
    mutationFn: () =>
      api<Organization>("/organization", {
        method: "PATCH",
        body: JSON.stringify({ name: orgName.trim() }),
      }),
    onSuccess: async () => {
      setFeedback("School profile updated.");
      setError("");
      await refresh();
    },
  });
  const passwordSave = useMutation({
    mutationFn: () =>
      api<void>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      }),
    onSuccess: async () => {
      setCurrentPassword("");
      setNewPassword("");
      setFeedback("Password changed; other active sessions were signed out.");
      setError("");
      await client.invalidateQueries({ queryKey: ["auth-sessions"] });
    },
  });
  const invitationSave = useMutation({
    mutationFn: () =>
      api<InviteCreated>("/staff/invitations", {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      }),
    onSuccess: async (result) => {
      setInviteEmail("");
      setCreatedInvite(result);
      setFeedback("Staff invitation recorded.");
      setError("");
      await refresh();
    },
  });
  const staffUpdate = useMutation({
    mutationFn: ({
      membershipId,
      path,
      body,
    }: {
      membershipId: string;
      path: string;
      body: Record<string, unknown>;
    }) =>
      api(`/staff/${membershipId}/${path}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: refresh,
  });
  const inviteRevoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/staff/invitations/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  const sessionRevoke = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/auth/sessions/${id}`, { method: "DELETE" }),
    onSuccess: async (_result, id) => {
      await client.invalidateQueries({ queryKey: ["auth-sessions"] });
      if (sessions.data?.find((item) => item.id === id)?.current) {
        client.setQueryData(["me"], null);
        window.location.assign("/login");
      }
    },
  });
  const submitAcademic = async (
    kind: string,
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault();
    setError("");
    setFeedback("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const name = String(form.get("name") || "").trim();
    let data: Record<string, unknown>;
    if (kind === "year")
      data = {
        label: name,
        starts_on: form.get("starts_on") || null,
        ends_on: form.get("ends_on") || null,
        is_current: form.get("is_current") === "on",
      };
    else if (kind === "term")
      data = {
        academic_year_id: String(form.get("academic_year_id") || ""),
        name,
      };
    else data = { name };
    try {
      await academicSave.mutateAsync({ kind, data });
      formElement.reset();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Could not save this school record.",
      );
    }
  };
  const reportMutationError = (failure: unknown) =>
    setError(
      failure instanceof Error
        ? failure.message
        : "The requested change could not be saved.",
    );
  if (
    years.isPending ||
    classes.isPending ||
    subjects.isPending ||
    terms.isPending
  )
    return <Loading label="Loading school setup…" />;
  const failed = [years, terms, classes, subjects].find(
    (query) => query.isError,
  );
  if (failed)
    return (
      <ErrorState
        message={failed.error?.message || "School setup could not be loaded."}
        onRetry={() => {
          void years.refetch();
          void terms.refetch();
          void classes.refetch();
          void subjects.refetch();
        }}
      />
    );
  return (
    <>
      <section className="panel pad setup-intro">
        <SectionTitle
          eyebrow="SCHOOL WORKSPACE"
          title="School setup"
          detail="School identity, staff access, account security and academic structures used by assessments."
          action={
            <StatusTag tone="blue">
              {roleLabels[user?.role || ""] || user?.role}
            </StatusTag>
          }
        />
        <div className="profile-summary">
          <span className="school-mark large-mark">
            {(user?.organization_name || "S").slice(0, 1).toUpperCase()}
          </span>
          <div>
            <b>{user?.organization_name}</b>
            <small>
              {user?.email} · {roleLabels[user?.role || ""] || user?.role}
            </small>
          </div>
        </div>
      </section>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {feedback && (
        <div className="alert alert-success" role="status">
          {feedback}
        </div>
      )}
      <div className="setup-grid account-grid">
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <Shield size={16} />
            </span>
            <div>
              <h3>School profile</h3>
              <p>Visible to members of this school workspace.</p>
            </div>
          </div>
          {isAdmin ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setError("");
                setFeedback("");
                void organizationSave.mutateAsync().catch(reportMutationError);
              }}
            >
              <label className="label" htmlFor="org-name">
                School name
              </label>
              <input
                id="org-name"
                className="field"
                minLength={2}
                maxLength={180}
                value={orgName}
                onChange={(event) => setOrgName(event.currentTarget.value)}
                required
              />
              <button
                className="btn primary"
                disabled={organizationSave.isPending || !orgName.trim()}
              >
                Save school profile
              </button>
            </form>
          ) : (
            <p>{organization.data?.name || user?.organization_name}</p>
          )}
        </section>
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <Users size={16} />
            </span>
            <div>
              <h3>Your profile</h3>
              <p>Update the name shown to school staff.</p>
            </div>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              setFeedback("");
              void profileSave.mutateAsync().catch(reportMutationError);
            }}
          >
            <label className="label" htmlFor="profile-name">
              Full name
            </label>
            <input
              id="profile-name"
              className="field"
              minLength={2}
              maxLength={160}
              value={fullName}
              onChange={(event) => setFullName(event.currentTarget.value)}
              required
            />
            <label className="label" htmlFor="profile-email">
              Account email
            </label>
            <input
              id="profile-email"
              className="field"
              type="email"
              value={user?.email || ""}
              readOnly
            />
            <button
              className="btn primary"
              disabled={profileSave.isPending || !fullName.trim()}
            >
              Save profile
            </button>
          </form>
        </section>
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <KeyRound size={16} />
            </span>
            <div>
              <h3>Change password</h3>
              <p>
                Use at least 12 characters. The operation revokes all other
                sessions.
              </p>
            </div>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError("");
              setFeedback("");
              void passwordSave.mutateAsync().catch(reportMutationError);
            }}
          >
            <label className="label" htmlFor="current-password">
              Current password
            </label>
            <input
              id="current-password"
              className="field"
              type="password"
              autoComplete="current-password"
              minLength={12}
              value={currentPassword}
              onChange={(event) =>
                setCurrentPassword(event.currentTarget.value)
              }
              required
            />
            <label className="label" htmlFor="new-password">
              New password
            </label>
            <input
              id="new-password"
              className="field"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              value={newPassword}
              onChange={(event) => setNewPassword(event.currentTarget.value)}
              required
            />
            <button
              className="btn primary"
              disabled={passwordSave.isPending || newPassword.length < 12}
            >
              Change password
            </button>
          </form>
        </section>
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <KeyRound size={16} />
            </span>
            <div>
              <h3>Active sessions</h3>
              <p>Remove access from another browser or device.</p>
            </div>
          </div>
          {sessions.isPending ? (
            <Loading label="Loading sessions…" />
          ) : sessions.isError ? (
            <ErrorState
              message={sessions.error.message}
              onRetry={() => void sessions.refetch()}
            />
          ) : (
            sessions.data?.map((session) => (
              <div className="session-row" key={session.id}>
                <span>
                  <b>
                    {session.current
                      ? "This session"
                      : "Other signed-in session"}
                  </b>
                  <small>
                    Signed in {new Date(session.created_at).toLocaleString()} ·
                    expires {new Date(session.expires_at).toLocaleDateString()}
                  </small>
                </span>
                {session.current ? (
                  <StatusTag tone="green">Current</StatusTag>
                ) : (
                  <button
                    className="btn danger-subtle"
                    disabled={sessionRevoke.isPending}
                    onClick={() =>
                      void sessionRevoke
                        .mutateAsync(session.id)
                        .catch(reportMutationError)
                    }
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))
          )}
          {!sessions.isPending && !sessions.data?.length && (
            <p className="muted small">No active sessions.</p>
          )}
        </section>
      </div>
      {isAdmin && (
        <section className="panel pad staff-panel">
          <SectionTitle
            eyebrow="SCHOOL ACCESS"
            title="Staff and invitations"
            detail="Invite colleagues to a defined school role. Access is enforced on every API request."
            action={
              <StatusTag tone="blue">
                {staff.data?.length || 0} members
              </StatusTag>
            }
          />
          {staff.isError && (
            <ErrorState
              message={staff.error.message}
              onRetry={() => void staff.refetch()}
            />
          )}
          {invitations.isError && (
            <ErrorState
              message={invitations.error.message}
              onRetry={() => void invitations.refetch()}
            />
          )}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>STAFF MEMBER</th>
                  <th>ROLE</th>
                  <th>EMAIL STATUS</th>
                  <th>ACCESS</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {staff.data?.map((member) => (
                  <tr key={member.membership_id}>
                    <td>
                      <b>{member.full_name}</b>
                      <small className="staff-subline">
                        {member.email}
                        {member.user_id === user?.id ? " · You" : ""}
                      </small>
                    </td>
                    <td>
                      <select
                        className="field compact-select"
                        aria-label={`Role for ${member.full_name}`}
                        value={member.role}
                        disabled={
                          staffUpdate.isPending || member.role === "owner"
                        }
                        onChange={(event) => {
                          if (
                            window.confirm(
                              `Change ${member.full_name}'s school role to ${roleLabels[event.currentTarget.value]}?`,
                            )
                          )
                            void staffUpdate
                              .mutateAsync({
                                membershipId: member.membership_id,
                                path: "role",
                                body: { role: event.currentTarget.value },
                              })
                              .catch(reportMutationError);
                        }}
                      >
                        <option value="owner" disabled>
                          Owner
                        </option>
                        {inviteRoles.map((role) => (
                          <option key={role} value={role}>
                            {roleLabels[role]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <StatusTag
                        tone={member.is_email_verified ? "green" : "amber"}
                      >
                        {member.is_email_verified ? "Verified" : "Unverified"}
                      </StatusTag>
                    </td>
                    <td>
                      <StatusTag tone={member.is_active ? "green" : "neutral"}>
                        {member.is_active ? "Active" : "Inactive"}
                      </StatusTag>
                    </td>
                    <td>
                      <button
                        className="btn"
                        disabled={
                          staffUpdate.isPending ||
                          (member.user_id === user?.id && member.is_active)
                        }
                        onClick={() => {
                          const active = !member.is_active;
                          if (
                            window.confirm(
                              `${active ? "Reactivate" : "Deactivate"} ${member.full_name}'s access to this school?`,
                            )
                          )
                            void staffUpdate
                              .mutateAsync({
                                membershipId: member.membership_id,
                                path: "activation",
                                body: { is_active: active },
                              })
                              .catch(reportMutationError);
                        }}
                      >
                        {member.is_active ? "Deactivate" : "Reactivate"}
                      </button>
                    </td>
                  </tr>
                ))}
                {!staff.isPending && !staff.data?.length && (
                  <tr>
                    <td colSpan={5}>No school members are recorded.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="settings-subsection">
            <h3>Invite staff</h3>
            <form
              className="invite-form"
              onSubmit={(event) => {
                event.preventDefault();
                setError("");
                setFeedback("");
                setCreatedInvite(null);
                void invitationSave.mutateAsync().catch(reportMutationError);
              }}
            >
              <div className="invite-email">
                <label className="label" htmlFor="invite-email">
                  Work email
                </label>
                <input
                  className="field"
                  id="invite-email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  value={inviteEmail}
                  onChange={(event) =>
                    setInviteEmail(event.currentTarget.value)
                  }
                  placeholder="colleague@school.edu.ng"
                  required
                />
              </div>
              <div>
                <label className="label" htmlFor="invite-role">
                  Role
                </label>
                <select
                  className="field"
                  id="invite-role"
                  value={inviteRole}
                  onChange={(event) => setInviteRole(event.currentTarget.value)}
                >
                  {inviteRoles.map((role) => (
                    <option key={role} value={role}>
                      {roleLabels[role]}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="btn primary invite-action"
                disabled={invitationSave.isPending}
              >
                <MailPlus size={15} />
                {invitationSave.isPending ? "Creating…" : "Send invitation"}
              </button>
            </form>
            {createdInvite && (
              <div className="alert alert-success" role="status">
                {createdInvite.message}
                {createdInvite.invitation_path && (
                  <>
                    {" "}
                    <a
                      href={createdInvite.invitation_path}
                      className="inline-action-link"
                    >
                      Open one-time invitation
                    </a>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="table-wrap invitation-table">
            <table className="data-table">
              <thead>
                <tr>
                  <th>INVITED EMAIL</th>
                  <th>ROLE</th>
                  <th>EXPIRES</th>
                  <th>STATE</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invitations.data?.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.email}</td>
                    <td>{roleLabels[invite.role] || invite.role}</td>
                    <td>{new Date(invite.expires_at).toLocaleDateString()}</td>
                    <td>
                      <StatusTag
                        tone={
                          invite.accepted_at
                            ? "green"
                            : invite.revoked_at || invite.expired
                              ? "neutral"
                              : "amber"
                        }
                      >
                        {invite.accepted_at
                          ? "Accepted"
                          : invite.revoked_at
                            ? "Revoked"
                            : invite.expired
                              ? "Expired"
                              : "Pending"}
                      </StatusTag>
                    </td>
                    <td>
                      {!invite.accepted_at &&
                        !invite.revoked_at &&
                        !invite.expired && (
                          <button
                            className="linkbtn"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Revoke the invitation for ${invite.email}?`,
                                )
                              )
                                void inviteRevoke
                                  .mutateAsync(invite.id)
                                  .catch(reportMutationError);
                            }}
                          >
                            Revoke
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
                {!invitations.isPending && !invitations.data?.length && (
                  <tr>
                    <td colSpan={5}>
                      No staff invitations have been recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <div className="setup-grid">
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <CalendarDays size={16} />
            </span>
            <div>
              <h3>Academic years</h3>
              <p>{years.data?.length || 0} recorded</p>
            </div>
          </div>
          <form onSubmit={(event) => void submitAcademic("year", event)}>
            <label className="label" htmlFor="year-name">
              Session name
            </label>
            <input
              className="field"
              id="year-name"
              name="name"
              placeholder="e.g. 2026/2027"
              required
              minLength={4}
              maxLength={40}
            />
            <div className="form-grid">
              <div>
                <label className="label" htmlFor="year-start">
                  Starts
                </label>
                <input
                  className="field"
                  type="date"
                  id="year-start"
                  name="starts_on"
                />
              </div>
              <div>
                <label className="label" htmlFor="year-end">
                  Ends
                </label>
                <input
                  className="field"
                  type="date"
                  id="year-end"
                  name="ends_on"
                />
              </div>
            </div>
            <label className="check-row">
              <input type="checkbox" name="is_current" /> Set as current school
              year
            </label>
            <button className="btn primary" disabled={academicSave.isPending}>
              Add academic year
            </button>
          </form>
          {years.data?.length ? (
            <div className="record-list">
              {years.data.map((item) => (
                <span key={item.id}>
                  {item.label}
                  {item.is_current && (
                    <StatusTag tone="green">Current</StatusTag>
                  )}
                </span>
              ))}
            </div>
          ) : (
            <p className="muted small">No academic years recorded.</p>
          )}
        </section>
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <Layers3 size={16} />
            </span>
            <div>
              <h3>Terms</h3>
              <p>{terms.data?.length || 0} recorded</p>
            </div>
          </div>
          <form onSubmit={(event) => void submitAcademic("term", event)}>
            <label className="label" htmlFor="term-year">
              Academic year
            </label>
            <select
              id="term-year"
              className="field"
              name="academic_year_id"
              required
              defaultValue=""
            >
              <option value="" disabled>
                Choose year
              </option>
              {(years.data || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <label className="label" htmlFor="term-name">
              Term name
            </label>
            <select id="term-name" className="field" name="name">
              <option>First Term</option>
              <option>Second Term</option>
              <option>Third Term</option>
              <option>Mock examination</option>
            </select>
            <button
              className="btn primary"
              disabled={academicSave.isPending || !years.data?.length}
            >
              Add term
            </button>
          </form>
          {terms.data?.length ? (
            <div className="record-list">
              {terms.data.map((item) => (
                <span key={item.id}>
                  {item.name}
                  <small>
                    {
                      years.data?.find(
                        (year) => year.id === item.academic_year_id,
                      )?.label
                    }
                  </small>
                </span>
              ))}
            </div>
          ) : (
            <p className="muted small">No terms recorded.</p>
          )}
        </section>
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <Users size={16} />
            </span>
            <div>
              <h3>Classes</h3>
              <p>{classes.data?.length || 0} recorded</p>
            </div>
          </div>
          <form onSubmit={(event) => void submitAcademic("class", event)}>
            <label className="label" htmlFor="class-name">
              Class name
            </label>
            <input
              className="field"
              id="class-name"
              name="name"
              placeholder="e.g. SS2"
              required
              maxLength={80}
            />
            <button className="btn primary" disabled={academicSave.isPending}>
              Add class
            </button>
          </form>
          {classes.data?.length ? (
            <div className="record-list">
              {classes.data.map((item) => (
                <span key={item.id}>{item.name}</span>
              ))}
            </div>
          ) : (
            <p className="muted small">No classes recorded.</p>
          )}
        </section>
        <section className="panel settings-card">
          <div className="settings-heading">
            <span className="metric-icon">
              <BookOpen size={16} />
            </span>
            <div>
              <h3>Subjects</h3>
              <p>{subjects.data?.length || 0} recorded</p>
            </div>
          </div>
          <form onSubmit={(event) => void submitAcademic("subject", event)}>
            <label className="label" htmlFor="subject-name">
              Subject name
            </label>
            <input
              className="field"
              id="subject-name"
              name="name"
              placeholder="e.g. Mathematics"
              required
              maxLength={100}
            />
            <button className="btn primary" disabled={academicSave.isPending}>
              Add subject
            </button>
          </form>
          {subjects.data?.length ? (
            <div className="record-list">
              {subjects.data.map((item) => (
                <span key={item.id}>{item.name}</span>
              ))}
            </div>
          ) : (
            <p className="muted small">No subjects recorded.</p>
          )}
        </section>
      </div>
      {canReadAudit && (
        <section className="panel pad audit-panel">
          <SectionTitle
            eyebrow="ACCOUNTABILITY"
            title="Recent school activity"
            detail="The latest recorded actions in this school only. Private answer content is not shown in this activity list."
            action={<StatusTag tone="neutral">Latest 50</StatusTag>}
          />
          {audit.isPending ? (
            <Loading label="Loading the audit trail…" />
          ) : audit.isError ? (
            <ErrorState
              message={audit.error.message}
              onRetry={() => void audit.refetch()}
            />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>TIME</th>
                    <th>ACTIVITY</th>
                    <th>RECORD</th>
                    <th>ACTOR</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data?.map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.created_at).toLocaleString()}</td>
                      <td>{event.action.replace(/[._]/g, " ")}</td>
                      <td>{event.entity_type.replace(/_/g, " ")}</td>
                      <td>
                        {event.actor_user_id
                          ? "School staff"
                          : "Former staff account"}
                      </td>
                    </tr>
                  ))}
                  {!audit.data?.length && (
                    <tr>
                      <td colSpan={4} className="muted">
                        No audit events are recorded for this school.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <section className="panel pad setup-limitations">
        <h3>Account and privacy controls</h3>
        <p className="muted small">
          School records and scripts are access-controlled by your active school
          membership. Use a dedicated verified school email service for live
          account delivery; development action links are available only in the
          non-production environment.
        </p>
      </section>
    </>
  );
}
