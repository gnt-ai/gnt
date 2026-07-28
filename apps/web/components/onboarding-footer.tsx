// Just the copyright line -- no Docs/home links the way DashboardFooter
// has. Mid-onboarding isn't a moment to invite someone away from the flow
// they're in the middle of completing.
export function OnboardingFooter() {
  return (
    <footer className="flex justify-center border-t border-border">
      <div className="flex items-center justify-center px-6 py-6 max-w-3xl w-full sm:border-x sm:border-border font-mono text-xs text-muted">
        <p>© 2026 gnt.ai</p>
      </div>
    </footer>
  );
}
