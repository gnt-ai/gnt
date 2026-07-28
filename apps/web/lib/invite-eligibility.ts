// Pulled out of lib/auth.ts's beforeCreateInvitation hook so the actual
// decision -- can this org invite someone who already belongs to another
// org -- is a plain function testable without a real Postgres connection.
// The hook itself stays thin: run the queries, hand the results here.
export function canInviteAcrossOrgs({
  hasOtherMembership,
  planTier,
}: {
  hasOtherMembership: boolean;
  planTier: string | null;
}): boolean {
  if (!hasOtherMembership) return true;
  return planTier === "pro";
}
