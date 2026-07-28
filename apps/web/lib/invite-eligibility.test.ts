import { describe, expect, it } from "vitest";
import { canInviteAcrossOrgs } from "./invite-eligibility";

describe("canInviteAcrossOrgs", () => {
  it("allows the invite when the invitee has no other org membership, regardless of plan", () => {
    expect(canInviteAcrossOrgs({ hasOtherMembership: false, planTier: null })).toBe(true);
    expect(canInviteAcrossOrgs({ hasOtherMembership: false, planTier: "base" })).toBe(true);
  });

  it("blocks a cross-org invite on the base plan", () => {
    expect(canInviteAcrossOrgs({ hasOtherMembership: true, planTier: "base" })).toBe(false);
  });

  it("blocks a cross-org invite when the org has no plan_tier row at all", () => {
    expect(canInviteAcrossOrgs({ hasOtherMembership: true, planTier: null })).toBe(false);
  });

  it("allows a cross-org invite only on the pro plan", () => {
    expect(canInviteAcrossOrgs({ hasOtherMembership: true, planTier: "pro" })).toBe(true);
  });
});
