import { describe, expect, it } from "vitest";
import { checkoutOutcome } from "./checkout-outcome";

describe("checkoutOutcome", () => {
  it("is a success on an ok response", () => {
    expect(checkoutOutcome(true, 200)).toBe("success");
  });

  it("degrades to /welcome on a 503 -- billing not configured shouldn't lock out a new signup", () => {
    expect(checkoutOutcome(false, 503)).toBe("degrade");
  });

  it("shows a retry error on any other failure", () => {
    expect(checkoutOutcome(false, 500)).toBe("error");
    expect(checkoutOutcome(false, 401)).toBe("error");
  });
});
