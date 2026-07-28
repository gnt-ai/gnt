/**
 * Deterministic, non-network fake reranker — Global Rule 6 (no real paid
 * API calls from a test loop). Returns no scores, so applyReranker's
 * fail-open path leaves the RRF-fused order untouched — the reranker
 * effectively no-ops, the same outcome production sees when zerank-2 is
 * unreachable. Lives in src/, not test/, so the HTTP server's test-mode
 * switch can import it too (mirrors fake-embed.ts's own rationale).
 */
import type { RerankFn } from "../native/rerank.ts";

export const fakeRerank: RerankFn = async () => [];
