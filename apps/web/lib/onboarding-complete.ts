// The one place "onboarding is done" is defined -- both the server-side
// DB-direct check (lib/onboarding-status.ts, gates /overview before
// render) and the client-side live check (lib/use-onboarding-status.ts,
// hides the Overview nav link until then) call this instead of each
// carrying their own copy of the bar. CLI + GitHub are the two hard
// requirements past install (see components/onboarding-status.tsx's own
// "Required" copy on the GitHub step) -- Slack stays optional, and
// reaching the 5-approved-rules milestone is a stretch goal, not the
// basic setup bar. At least one proposed rule is proof `gnt prebrain`
// actually ran end to end, not just that the CLI and GitHub got connected.
export function isOnboardingComplete(status: {
  connected_cli: boolean;
  connected_github: boolean;
  rules_proposed: number;
}): boolean {
  return status.connected_cli && status.connected_github && status.rules_proposed > 0;
}
