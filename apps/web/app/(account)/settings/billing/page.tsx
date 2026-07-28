import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";
import { fetchServerApi, fetchServerApiResult } from "@/lib/server-api";
import { BillingSettingsClient, type BillingStatus, type Invoice, type PaymentMethod } from "./billing-settings-client";

export default async function BillingSettingsPage() {
  const session = await getServerSession();
  if (!session) redirect("/sign-in");
  // Fetched here, in parallel, so the page arrives with real content
  // instead of BillingSettingsClient mounting to three empty panels and
  // mint-fetching each one itself. Payment method uses the `ok`-carrying
  // variant, not the plain null-collapsing one -- "no card on file" is a
  // real successful response (null), and conflating that with "fetch
  // failed" would make BillingSettingsClient redundantly re-fetch it
  // client-side every time an org genuinely has no card. Status/invoices
  // don't have that ambiguity (a real response is never itself null), so
  // the plain helper is fine there.
  const [status, paymentMethodResult, invoices] = await Promise.all([
    fetchServerApi<BillingStatus>("/v1/billing/status"),
    fetchServerApiResult<PaymentMethod>("/v1/billing/payment-method"),
    fetchServerApi<Invoice[]>("/v1/billing/invoices"),
  ]);
  return (
    <BillingSettingsClient
      initialStatus={status}
      initialPaymentMethod={paymentMethodResult}
      initialInvoices={invoices}
    />
  );
}
