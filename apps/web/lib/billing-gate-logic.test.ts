import { describe, expect, it } from "vitest";
import { checkBillingRedirect } from "./billing-gate-logic";

function fakeResponse(ok: boolean, body: unknown): () => Promise<Response> {
  return () =>
    Promise.resolve({
      ok,
      json: () => Promise.resolve(body),
    } as Response);
}

describe("checkBillingRedirect", () => {
  it("redirects when subscription_status is null", async () => {
    const redirect = await checkBillingRedirect(fakeResponse(true, { subscription_status: null }));
    expect(redirect).toBe(true);
  });

  it("does not redirect once a subscription is active", async () => {
    const redirect = await checkBillingRedirect(fakeResponse(true, { subscription_status: "active" }));
    expect(redirect).toBe(false);
  });

  it("does not redirect on a 403 -- a non-admin member isn't bounced to billing for an org they don't manage", async () => {
    const redirect = await checkBillingRedirect(fakeResponse(false, { subscription_status: null }));
    expect(redirect).toBe(false);
  });

  it("fails open (no redirect) when the fetch itself throws", async () => {
    const redirect = await checkBillingRedirect(() => Promise.reject(new Error("network down")));
    expect(redirect).toBe(false);
  });

  it("fails open when the response body isn't valid JSON", async () => {
    const redirect = await checkBillingRedirect(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response),
    );
    expect(redirect).toBe(false);
  });
});
