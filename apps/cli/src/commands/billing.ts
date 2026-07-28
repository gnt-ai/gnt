import open from "open";
import { API_URL } from "../config.js";
import { loadApiKey } from "../credentials.js";
import { dim, fail, text } from "../theme.js";

export async function billing(): Promise<void> {
  const key = loadApiKey();

  const statusRes = await fetch(`${API_URL}/v1/billing/status`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!statusRes.ok) {
    console.error(fail(`Failed to fetch billing status (${statusRes.status}).`));
    process.exit(1);
  }
  const billingStatus = await statusRes.json();

  // subscription_status is only ever non-null once an org has gone
  // through Checkout at least once (see gnt/billing.py) -- even a
  // canceled subscription means there's a Stripe customer to manage via
  // the portal. Never having subscribed means there's nothing for the
  // portal to show, so that first pass goes through Checkout instead.
  const endpoint = billingStatus.subscription_status ? "portal" : "checkout";
  const res = await fetch(`${API_URL}/v1/billing/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(fail(`Failed to start billing (${res.status}).`));
    process.exit(1);
  }
  const { url } = await res.json();

  console.log(dim(url));
  try {
    await open(url);
    console.log(text("Opened in your browser."));
  } catch {
    console.log(text("Couldn't open a browser automatically — open the URL above manually."));
  }
}
