// Typed fetch wrapper. One place that knows the API returns JSON errors, so no
// screen has to remember to unwrap them.

export interface Tender {
  id: string;
  name: string;
  buyer: string;
  reference: string;
  lot: string;
  value: string;
  currency: string;
  deadline_at: string;
  clarification_deadline_at: string;
  source_url: string;
  pack_id: string;
  status: string;
  decision_note: string;
  created_at: string;
  updated_at: string;
}

export interface TenderRow extends Tender {
  document_count: number;
  requirement_count: number;
  verdict: string;
  reason: string;
  days_to_deadline: number | null;
}

export interface Finding {
  document_id: string | null;
  stated: string;
  quote: string;
  page_no: number | null;
  /** met | not_met | unknown | not_stated | rejected */
  status: string;
  our_evidence: string;
  rationale: string;
  rejected_reason: string;
  updated_at: string;
}

export interface Requirement {
  id: string;
  key: string;
  label: string;
  family: string;
  /** mandatory | scored | optional */
  obligation: string;
  weighting: string;
  hint: string;
  capability_key: string;
  position: number;
  finding: Finding | null;
}

export interface Capability {
  key: string;
  label: string;
  category: string;
  value: string;
  evidence: string;
  expires_at: string;
  notes: string;
  updated_at: string;
}

export interface FamilyRoll {
  family: string;
  met: number;
  total: number;
  /** pass | blocked | unknown | not_applicable */
  state: string;
}

export interface Verdict {
  /** go | no_go | blocked | unknown */
  verdict: string;
  reason: string;
  blockers: { key: string; label: string; stated: string; our_evidence: string }[];
  open_questions: { key: string; label: string; reason: string }[];
  families: FamilyRoll[];
  scored: { answered: number; total: number };
  days_to_deadline: number | null;
  days_to_clarification_deadline: number | null;
}

export interface TenderDetail {
  tender: Tender;
  requirements: Requirement[];
  capabilities: Capability[];
  verdict: Verdict;
  document_count: number;
}

export interface TenderDocument {
  id: string;
  tender_id: string;
  name: string;
  kind: string;
  mime: string;
  size_bytes: number;
  page_count: number;
  locator_kind: string;
  extract_status: string;
  extract_error: string;
  created_at: string;
}

export interface Pack {
  id: string;
  name: string;
  description: string;
  jurisdiction: string;
  requirement_count: number;
  mandatory_count: number;
  publisher: string;
  licence: string;
  source_url: string;
}

export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  // 422 is not an error here — it is the verification result, and the caller
  // needs the body to show which findings were rejected and why.
  if (!res.ok && res.status !== 422) throw new ApiError(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  tenders: (params = "") => request<{ tenders: TenderRow[]; total: number }>(`/api/tenders?${params}`),
  tender: (id: string) => request<TenderDetail>(`/api/tenders/${id}`),
  verdict: (id: string) => request<Verdict>(`/api/tenders/${id}/verdict`),
  createTender: (body: Record<string, unknown>) =>
    request<Tender & { requirements_added: number }>("/api/tenders", { method: "POST", body: JSON.stringify(body) }),
  updateTender: (id: string, body: Record<string, unknown>) =>
    request<Tender>(`/api/tenders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTender: (id: string) => request<{ ok: boolean }>(`/api/tenders/${id}`, { method: "DELETE" }),

  packs: () => request<{ packs: Pack[] }>("/api/packs"),
  applyPack: (tenderId: string, packId: string) =>
    request<{ added: number; skipped: number }>(`/api/tenders/${tenderId}/pack`, {
      method: "POST",
      body: JSON.stringify({ pack_id: packId }),
    }),
  deleteRequirement: (id: string) => request<{ ok: boolean }>(`/api/requirements/${id}`, { method: "DELETE" }),
  updateRequirement: (id: string, body: Record<string, unknown>) =>
    request<Requirement>(`/api/requirements/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  documents: (tenderId: string) => request<{ documents: TenderDocument[] }>(`/api/tenders/${tenderId}/documents`),
  upload: (tenderId: string, file: File, kind: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("kind", kind);
    return request<TenderDocument>(`/api/tenders/${tenderId}/documents`, { method: "POST", body: form });
  },
  deleteDocument: (id: string) => request<{ ok: boolean }>(`/api/documents/${id}`, { method: "DELETE" }),

  capabilities: () => request<{ capabilities: Capability[] }>("/api/capabilities"),
  putCapability: (key: string, body: Record<string, unknown>) =>
    request<Capability>(`/api/capabilities/${key}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteCapability: (key: string) => request<{ ok: boolean }>(`/api/capabilities/${key}`, { method: "DELETE" }),

  recheck: (id: string) =>
    request<{
      available: boolean;
      checked: number;
      pages_read: number;
      flagged: { requirement: string; label: string; document: string; page_no: number; probability: number }[];
      verdict: Verdict;
    }>(`/api/tenders/${id}/recheck`, { method: "POST", body: "{}" }),

  qualify: (id: string) =>
    request<{ dispatched: boolean; brief: string; error?: string }>(`/api/tenders/${id}/qualify`, {
      method: "POST",
      body: "{}",
    }),
  agent: () =>
    request<{
      available: boolean;
      reachable: boolean;
      server_id: string | null;
      servers: { id: string; name: string | null; status: string | null }[];
    }>("/api/agent"),
};
