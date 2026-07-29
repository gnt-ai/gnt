"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";

// Deliberate enforcement compromise: 2FA is "required" for
// owner/admin, but nothing here hard-blocks org creation or a brand-new
// owner's first sign-in -- the instant an org exists its owner obviously
// hasn't enabled 2FA yet, so a hard block would lock out the one person
// who needs to set it up. Instead: this nag (shown wherever an owner/admin
// without 2FA lands) plus components/two-factor-gate.tsx gating the one
// admin-sensitive action the web app currently exposes (minting a CLI key
// via app/cli-login/page.tsx, and the settings page itself) once 2FA
// *is* enabled. There's no other admin-only frontend surface today to gate
// further -- see the PR description for the full writeup.
export function TwoFactorNag() {
  const { data: session } = useSession();
  const [isAdminRole, setIsAdminRole] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    authClient.organization.getActiveMemberRole().then(({ data }) => {
      if (!cancelled) setIsAdminRole(data?.role === "owner" || data?.role === "admin");
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session || session.user.twoFactorEnabled || !isAdminRole) return null;

  return (
    <Link
      href="/settings/security"
      className="group w-full flex items-center gap-3 border border-border bg-surface-low px-4 py-3 hover:border-foreground/40 transition-colors duration-150 ease-out-strong"
    >
      <ShieldAlert className="h-4 w-4 text-error shrink-0" aria-hidden="true" />
      <span className="font-mono text-sm text-foreground">
        Two-factor authentication is required for your role and isn&apos;t set up yet.{" "}
        <span className="underline group-hover:opacity-80 transition-opacity duration-150 ease-out-strong">
          Enable it
        </span>
        .
      </span>
    </Link>
  );
}
