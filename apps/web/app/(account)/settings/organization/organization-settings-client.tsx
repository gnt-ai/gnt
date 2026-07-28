"use client";

import { useEffect, useRef, useState } from "react";
import { AccountSidebarToggle } from "@/components/account-sidebar";
import { BillingGate } from "@/components/billing-gate";
import { TwoFactorGate } from "@/components/two-factor-gate";
import { API_URL } from "@/lib/api-url";
import { authClient } from "@/lib/auth-client";
import type { auth } from "@/lib/auth";

type ServerSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

type Role = "owner" | "admin" | "member";
type InviteRole = "member" | "admin";

// Same shape better-auth's findFullOrganization returns (see the
// organization plugin's adapter.mjs) -- typed by hand here since the
// client's $Infer types are empty objects until additionalFields are
// configured (checked the installed source, this isn't a gap specific to
// this app).
type Member = {
  id: string;
  userId: string;
  role: string;
  user: { id: string; name: string; email: string };
};
type Invitation = { id: string; email: string; role: string; status: string; expiresAt: string };
export type FullOrganization = { id: string; name: string; slug: string; members: Member[]; invitations: Invitation[] };

// GET /v1/settings/github's own response shape (routers/github.py's
// _serialize) -- connection_type distinguishes the GitHub App flow from a
// still-PAT-connected org (see GithubConnection's own docstring on why an
// org is on exactly one of the two at a time).
export type GithubStatus = { connected: false } | { connected: true; repo_url: string; default_branch: string; connection_type: "app" | "pat" };

// GET /v1/notion/status and /v1/linear/status's own response shapes
// (routers/notion.py, routers/linear.py) -- OAuth sprint T14's dashboard
// track. Notion's carries a workspace_name (its own OAuth token response
// includes one); Linear's carries nothing beyond connected, since Linear's
// token response has no workspace identity to show (see LinearConnection's
// own docstring in apps/api/src/gnt/db/models.py).
export type NotionStatus = { connected: false } | { connected: true; workspace_name: string | null };
export type LinearStatus = { connected: boolean };

// The session is already resolved server-side (see page.tsx), and so is
// the org itself (auth.api.getFullOrganization, passed down as
// initialOrg) -- authClient.useActiveOrganization() is still the thing
// rename/invite/remove/refetch talk to (no server equivalent for that
// live piece), but its own `data` takes over from initialOrg the moment
// it resolves, so the page never blocks on `isPending` for first paint --
// that used to replace the entire page (header, members, connectors, the
// works) with a single centered "Loading…" the instant org data landed,
// which is about as large a layout shift as this page could produce.
// page.tsx also fetches the github/notion/linear connector status itself
// and passes it down as initialGithubStatus/initialNotionStatus/
// initialLinearStatus, so those three cards render filled-in on arrival
// instead of each mounting to "Loading…" and mint-fetching its own token.
// The effects below only run when their initial value came back null (no
// server token, apps/api hiccup) -- same fetch-and-render path this page
// always had, now just a fallback.
export function OrganizationSettingsClient({
  session,
  initialOrg,
  initialGithubStatus,
  initialNotionStatus,
  initialLinearStatus,
}: {
  session: ServerSession;
  initialOrg: FullOrganization | null;
  initialGithubStatus: GithubStatus | null;
  initialNotionStatus: NotionStatus | null;
  initialLinearStatus: LinearStatus | null;
}) {
  const { data: liveOrg, isPending: orgPending, refetch } = authClient.useActiveOrganization() as {
    data: FullOrganization | null;
    isPending: boolean;
    refetch: () => void;
  };
  const org = liveOrg ?? initialOrg;

  const nameRef = useRef<HTMLInputElement>(null);
  const [savingName, setSavingName] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("member");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [githubStatus, setGithubStatus] = useState<GithubStatus | null>(initialGithubStatus);
  const [githubLoading, setGithubLoading] = useState(initialGithubStatus === null);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [connectingGithub, setConnectingGithub] = useState(false);

  const [notionStatus, setNotionStatus] = useState<NotionStatus | null>(initialNotionStatus);
  const [notionLoading, setNotionLoading] = useState(initialNotionStatus === null);
  const [notionError, setNotionError] = useState<string | null>(null);
  const [connectingNotion, setConnectingNotion] = useState(false);

  const [linearStatus, setLinearStatus] = useState<LinearStatus | null>(initialLinearStatus);
  const [linearLoading, setLinearLoading] = useState(initialLinearStatus === null);
  const [linearError, setLinearError] = useState<string | null>(null);
  const [connectingLinear, setConnectingLinear] = useState(false);

  const myRole = (org?.members.find((m) => m.userId === session.user.id)?.role ?? null) as Role | null;
  const canManage = myRole === "owner" || myRole === "admin";
  const pendingInvitations = org?.invitations.filter((i) => i.status === "pending") ?? [];

  useEffect(() => {
    if (initialGithubStatus !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error: tokenError } = await authClient.token();
      const token = data?.token;
      if (tokenError || !token) {
        if (!cancelled) setGithubError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setGithubLoading(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/settings/github`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (cancelled) return;
        if (!res.ok) {
          setGithubError("Couldn't load your GitHub connection. Try again in a moment.");
          return;
        }
        setGithubStatus(await res.json());
      } catch {
        if (!cancelled) setGithubError("Couldn't reach gnt's servers. Check your connection and try again.");
      } finally {
        if (!cancelled) setGithubLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // Mount-once is enough -- the GitHub App callback (apps/web/app/api/
    // github/callback) redirects back here (?github=connected) with a
    // real full-page navigation, which remounts this component and reruns
    // this effect anyway, same as any other page load. initialGithubStatus
    // is a one-time seed for the same reason, not a dep this should re-run on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drives the browser straight to GitHub's own install page -- the
  // server-signed state param (apps/api/src/gnt/github/app_auth.py's
  // build_install_state) is what binds the install back to this org, not
  // anything client-side, so this is a plain top-level navigation, not a
  // fetch-then-render flow.
  async function connectGithub() {
    setGithubError(null);
    setConnectingGithub(true);
    const { data, error: tokenError } = await authClient.token();
    const token = data?.token;
    if (tokenError || !token) {
      setConnectingGithub(false);
      setGithubError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/settings/github/app/install-url`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setConnectingGithub(false);
        setGithubError("Couldn't start the GitHub connection. Try again in a moment.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setConnectingGithub(false);
      setGithubError("Couldn't reach gnt's servers. Check your connection and try again.");
    }
  }

  // OAuth sprint T14 -- same shape as GitHub's own load/connect pair above,
  // one copy per connector rather than a shared abstraction, matching how
  // this file already keeps GitHub's own version inline rather than
  // factored out. Both callbacks (apps/api's routers/notion.py/linear.py)
  // redirect back to this same page (?notion=connected / ?linear=connected)
  // with a real full-page navigation, which remounts this component and
  // reruns these effects -- no client-side state syncing needed across the
  // redirect boundary, same note connectGithub's own effect makes.
  useEffect(() => {
    if (initialNotionStatus !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error: tokenError } = await authClient.token();
      const token = data?.token;
      if (tokenError || !token) {
        if (!cancelled) setNotionError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setNotionLoading(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/notion/status`, { headers: { Authorization: `Bearer ${token}` } });
        if (cancelled) return;
        if (!res.ok) {
          setNotionError("Couldn't load your Notion connection. Try again in a moment.");
          return;
        }
        setNotionStatus(await res.json());
      } catch {
        if (!cancelled) setNotionError("Couldn't reach gnt's servers. Check your connection and try again.");
      } finally {
        if (!cancelled) setNotionLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialNotionStatus is a one-time seed, same reasoning as the github effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectNotion() {
    setNotionError(null);
    setConnectingNotion(true);
    const { data, error: tokenError } = await authClient.token();
    const token = data?.token;
    if (tokenError || !token) {
      setConnectingNotion(false);
      setNotionError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/notion/install-url`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        setConnectingNotion(false);
        setNotionError("Couldn't start the Notion connection. Try again in a moment.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setConnectingNotion(false);
      setNotionError("Couldn't reach gnt's servers. Check your connection and try again.");
    }
  }

  useEffect(() => {
    if (initialLinearStatus !== null) return;
    let cancelled = false;
    async function load() {
      const { data, error: tokenError } = await authClient.token();
      const token = data?.token;
      if (tokenError || !token) {
        if (!cancelled) setLinearError("Couldn't verify your session. Try signing in again.");
        if (!cancelled) setLinearLoading(false);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/v1/linear/status`, { headers: { Authorization: `Bearer ${token}` } });
        if (cancelled) return;
        if (!res.ok) {
          setLinearError("Couldn't load your Linear connection. Try again in a moment.");
          return;
        }
        setLinearStatus(await res.json());
      } catch {
        if (!cancelled) setLinearError("Couldn't reach gnt's servers. Check your connection and try again.");
      } finally {
        if (!cancelled) setLinearLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // initialLinearStatus is a one-time seed, same reasoning as the github effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectLinear() {
    setLinearError(null);
    setConnectingLinear(true);
    const { data, error: tokenError } = await authClient.token();
    const token = data?.token;
    if (tokenError || !token) {
      setConnectingLinear(false);
      setLinearError("Couldn't verify your session. Try again.");
      return;
    }
    try {
      const res = await fetch(`${API_URL}/v1/linear/install-url`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        setConnectingLinear(false);
        setLinearError("Couldn't start the Linear connection. Try again in a moment.");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setConnectingLinear(false);
      setLinearError("Couldn't reach gnt's servers. Check your connection and try again.");
    }
  }

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!org) return;
    setError(null);
    const name = nameRef.current?.value.trim();
    if (!name) return;
    setSavingName(true);
    const { error: updateError } = await authClient.organization.update({
      organizationId: org.id,
      data: { name },
    });
    setSavingName(false);
    if (updateError) {
      setError(updateError.message ?? "Couldn't rename the organization. Try again.");
      return;
    }
    refetch();
  }

  async function sendInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!org) return;
    setError(null);
    setInviting(true);
    const { error: inviteError } = await authClient.organization.inviteMember({
      email: inviteEmail,
      role: inviteRole,
      organizationId: org.id,
    });
    setInviting(false);
    if (inviteError) {
      setError(inviteError.message ?? "Couldn't send that invite. Try again.");
      return;
    }
    setInviteEmail("");
    refetch();
  }

  async function removeMember(member: Member) {
    if (!org) return;
    setError(null);
    setBusyId(member.id);
    const { error: removeError } = await authClient.organization.removeMember({
      memberIdOrEmail: member.id,
      organizationId: org.id,
    });
    setBusyId(null);
    if (removeError) {
      setError(removeError.message ?? "Couldn't remove that member. Try again.");
      return;
    }
    refetch();
  }

  async function cancelInvitation(invitation: Invitation) {
    setError(null);
    setBusyId(invitation.id);
    const { error: cancelError } = await authClient.organization.cancelInvitation({
      invitationId: invitation.id,
    });
    setBusyId(null);
    if (cancelError) {
      setError(cancelError.message ?? "Couldn't cancel that invite. Try again.");
      return;
    }
    refetch();
  }

  if (orgPending && !org) {
    return (
      <>
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <AccountSidebarToggle />
          <h1 className="font-mono text-lg font-semibold text-foreground">Organization</h1>
        </header>
        <main className="flex-1 flex items-center justify-center px-6 py-16">
          <p className="font-mono text-sm text-muted">Loading…</p>
        </main>
      </>
    );
  }

  if (!org) {
    return (
      <>
        <TwoFactorGate />
        <BillingGate />
        <header className="flex items-center gap-3 border-b border-border px-6 py-4">
          <AccountSidebarToggle />
          <h1 className="font-mono text-lg font-semibold text-foreground">Organization</h1>
        </header>
        <main className="flex-1 flex items-center justify-center px-6 py-16">
          <p className="font-mono text-sm text-muted">No active organization.</p>
        </main>
      </>
    );
  }

  return (
    <>
      <TwoFactorGate />
      <BillingGate />
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <AccountSidebarToggle />
        <h1 className="font-mono text-lg font-semibold text-foreground">Organization</h1>
      </header>
      <main className="flex-1 flex flex-col items-center px-6 py-8">
        <div className="w-full flex flex-col items-start gap-6 text-left">
          <div className="flex flex-col items-start gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Settings</p>
            <h1 className="font-mono text-2xl font-bold tracking-tight">Organization</h1>
            <p className="font-mono text-sm text-muted">
              {canManage
                ? "Rename your organization and manage who's on it."
                : "Only owners and admins can rename the organization or manage members."}
            </p>
          </div>

          <div className="w-full flex flex-col gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Name</p>
            {canManage ? (
              <form onSubmit={saveName} className="flex gap-2">
                <input
                  key={org.id}
                  ref={nameRef}
                  type="text"
                  required
                  defaultValue={org.name}
                  className="flex-1 rounded-[4px] bg-surface-low border border-border text-foreground focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm outline-none"
                />
                <button
                  type="submit"
                  disabled={savingName}
                  className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-4 py-2 disabled:opacity-50"
                >
                  {savingName ? "Saving..." : "Save"}
                </button>
              </form>
            ) : (
              <p className="font-mono text-sm text-foreground">{org.name}</p>
            )}
          </div>

          <div className="w-full flex flex-col gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              Members ({org.members.length})
            </p>
            {/* Capped and internally scrollable -- member count grows
                without bound, and letting it push the whole page taller
                would eventually blow past a single viewport. */}
            <div className="w-full max-h-56 overflow-y-auto flex flex-col border border-border divide-y divide-border">
              {org.members.map((member) => (
                <div key={member.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                  <div className="flex flex-col min-w-0">
                    <span className="font-mono text-sm text-foreground truncate">
                      {member.user.name || member.user.email}
                    </span>
                    {member.user.name && (
                      <span className="font-mono text-xs text-muted truncate">{member.user.email}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-xs uppercase tracking-widest text-muted">
                      {member.role}
                    </span>
                    {canManage && member.userId !== session.user.id && (
                      <button
                        type="button"
                        onClick={() => removeMember(member)}
                        disabled={busyId === member.id}
                        className="font-mono text-sm text-muted hover:text-error transition-colors duration-150 ease-out-strong disabled:opacity-50"
                      >
                        {busyId === member.id ? "Removing..." : "Remove"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="w-full flex flex-col gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">GitHub</p>
            {githubLoading ? (
              <p className="font-mono text-sm text-muted">Loading…</p>
            ) : githubStatus?.connected ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-mono text-sm text-foreground">
                  Connected to {githubStatus.repo_url} (<span className="text-muted">{githubStatus.default_branch}</span>)
                  {githubStatus.connection_type === "pat" && (
                    <span className="text-muted"> — PAT-based, not the GitHub App</span>
                  )}
                </p>
                {canManage && githubStatus.connection_type === "pat" && (
                  <button
                    type="button"
                    onClick={connectGithub}
                    disabled={connectingGithub}
                    className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-4 py-2 disabled:opacity-50"
                  >
                    {connectingGithub ? "Redirecting…" : "Upgrade to the GitHub App"}
                  </button>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-mono text-sm text-muted">No rules repo connected yet.</p>
                {canManage && (
                  <button
                    type="button"
                    onClick={connectGithub}
                    disabled={connectingGithub}
                    className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-4 py-2 disabled:opacity-50"
                  >
                    {connectingGithub ? "Redirecting…" : "Connect GitHub"}
                  </button>
                )}
              </div>
            )}
            {githubError && <p className="text-sm text-error">{githubError}</p>}
          </div>

          <div className="w-full flex flex-col gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Notion</p>
            {notionLoading ? (
              <p className="font-mono text-sm text-muted">Loading…</p>
            ) : notionStatus?.connected ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-mono text-sm text-foreground">
                  Connected{notionStatus.workspace_name ? ` to ${notionStatus.workspace_name}` : ""}
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-mono text-sm text-muted">Not connected yet.</p>
                {canManage && (
                  <button
                    type="button"
                    onClick={connectNotion}
                    disabled={connectingNotion}
                    className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-4 py-2 disabled:opacity-50"
                  >
                    {connectingNotion ? "Redirecting…" : "Connect Notion"}
                  </button>
                )}
              </div>
            )}
            {notionError && <p className="text-sm text-error">{notionError}</p>}
          </div>

          <div className="w-full flex flex-col gap-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">Linear</p>
            {linearLoading ? (
              <p className="font-mono text-sm text-muted">Loading…</p>
            ) : linearStatus?.connected ? (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-mono text-sm text-foreground">Connected</p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="font-mono text-sm text-muted">Not connected yet.</p>
                {canManage && (
                  <button
                    type="button"
                    onClick={connectLinear}
                    disabled={connectingLinear}
                    className="rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-4 py-2 disabled:opacity-50"
                  >
                    {connectingLinear ? "Redirecting…" : "Connect Linear"}
                  </button>
                )}
              </div>
            )}
            {linearError && <p className="text-sm text-error">{linearError}</p>}
          </div>

          {canManage && pendingInvitations.length > 0 && (
            <div className="w-full flex flex-col gap-2">
              <p className="font-mono text-xs uppercase tracking-widest text-muted">
                Pending invitations ({pendingInvitations.length})
              </p>
              <div className="w-full max-h-40 overflow-y-auto flex flex-col border border-border divide-y divide-border">
                {pendingInvitations.map((invitation) => (
                  <div key={invitation.id} className="flex items-center justify-between px-4 py-2.5 gap-3">
                    <span className="font-mono text-sm text-foreground truncate">{invitation.email}</span>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="font-mono text-xs uppercase tracking-widest text-muted">
                        {invitation.role}
                      </span>
                      <button
                        type="button"
                        onClick={() => cancelInvitation(invitation)}
                        disabled={busyId === invitation.id}
                        className="font-mono text-sm text-muted hover:text-error transition-colors duration-150 ease-out-strong disabled:opacity-50"
                      >
                        {busyId === invitation.id ? "Canceling..." : "Cancel"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {canManage && (
            <div className="w-full flex flex-col gap-3">
              <p className="font-mono text-xs uppercase tracking-widest text-muted">Invite someone</p>
              <form onSubmit={sendInvite} className="flex flex-col gap-3">
                <div className="flex gap-2">
                  <input
                    type="email"
                    required
                    placeholder="teammate@company.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    className="flex-1 rounded-[4px] bg-surface-low border border-border text-foreground placeholder:text-muted/50 focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm outline-none"
                  />
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as InviteRole)}
                    className="rounded-[4px] bg-surface-low border border-border text-foreground focus:border-foreground/40 transition-colors duration-150 ease-out-strong px-3 py-2 text-sm outline-none"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                </div>
                <button
                  type="submit"
                  disabled={inviting}
                  className="self-start rounded-[4px] bg-accent-brand text-accent-brand-foreground font-mono text-sm font-medium hover:opacity-90 active:scale-95 transition-[opacity,transform] duration-150 ease-out-strong px-4 py-2 disabled:opacity-50"
                >
                  {inviting ? "Sending..." : "Send invite"}
                </button>
              </form>
            </div>
          )}

          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      </main>
    </>
  );
}
