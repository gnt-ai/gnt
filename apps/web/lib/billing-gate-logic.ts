// Pulled out of components/billing-gate.tsx so the redirect decision --
// fail open on any error, redirect only on a definitive null
// subscription_status, never redirect a non-ok response (a 403 for a
// non-admin member included) -- can be unit tested without mounting a
// component or faking the DOM.
export async function checkBillingRedirect(fetchStatus: () => Promise<Response>): Promise<boolean> {
  try {
    const res = await fetchStatus();
    if (!res.ok) return false;
    const status = await res.json();
    return !status.subscription_status;
  } catch {
    // Network hiccup or a non-JSON body -- fail open, same posture as the
    // rest of this app's best-effort status checks (see billing-gate.tsx).
    return false;
  }
}
