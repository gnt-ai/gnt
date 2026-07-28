import { API_URL } from "@/lib/api-url";
import { getServerApiToken } from "@/lib/auth";

export type ServerApiResult<T> = { ok: true; data: T } | { ok: false; data: null };

// Server-component counterpart to the client-side "mint a token, fetch,
// setState" effects scattered across the dashboard pages (overview,
// settings/billing, settings/organization). `ok` is false on any failure
// (no token, network error, non-2xx) -- callers pass `data` straight
// through as a page's initialX prop, and the existing client component
// already knows how to fall back to its own fetch (with its own specific
// error copy) when `ok` is false. This never removes that fallback, it
// just skips it on the common, fast path. `ok` exists separately from
// `data` because a couple of these endpoints (payment-method) have `null`
// as a legitimate successful response, not just a "didn't load" sentinel.
// no-store: every response here is per-org and can carry billing/PII, so
// it must never be shared across requests or users.
export async function fetchServerApiResult<T>(path: string): Promise<ServerApiResult<T>> {
  const token = await getServerApiToken();
  if (!token) return { ok: false, data: null };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, data: null };
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, data: null };
  }
}

// Thin convenience wrapper for the common case (rules, gaps, github/notion/
// linear status) where a successful response is never itself `null`, so
// collapsing `ok: false` into `data: null` loses nothing.
export async function fetchServerApi<T>(path: string): Promise<T | null> {
  return (await fetchServerApiResult<T>(path)).data;
}
