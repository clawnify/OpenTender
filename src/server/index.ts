import { createApp, createRoute, user, z } from "@clawnify/app";
import { get, query, run } from "./db.js";
import { verifyQuote, type PageText } from "./citations.js";
import { extract, isSupported, UnsupportedFileError } from "./extract.js";
import { catalogue, findPack } from "./packs.js";
import { MAX_PAGES_PER_SWEEP, decisionsAvailable, findImposed } from "./decisions.js";
import { buildVerdict, daysUntil, type FindingRow, type RequirementRow } from "./verdict.js";
import {
  dispatchAvailable,
  dispatchTask,
  listAgentServers,
  qualifyBrief,
} from "./agent.js";

type Env = {
  Bindings: {
    DB: D1Database;
    /** Per-app bucket holding the original tender documents. */
    UPLOADS: R2Bucket;
    /** Minted per org by the platform; required to hand a tender to the agent. */
    CLAWNIFY_TOKEN?: string;
    /** Override the platform agent endpoint — local testing only. */
    CLAWNIFY_AGENTS_URL?: string;
    /**
     * Resolved per org at deploy time from the manifest's env declaration.
     * Absent off-platform, and the second read (see decisions.ts) is then
     * simply unavailable rather than broken.
     */
    OPENROUTER_API_KEY?: string;
  };
};

// createApp bakes in OpenAPIHono construction, the per-request initDB
// middleware and /api/openapi.json + /llms.txt discovery.
const app = createApp<Env>({
  title: "Open Tender",
  version: "1.0.0",
  description:
    "Bid/no-bid on a public tender pack. Load a jurisdiction's selection questions as rows, let the agent read the documents against them, and get a verdict where every answer carries a quote the app can actually find in the source.",
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// ── Shared schemas ───────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const PaginationQuery = z.object({
  page: z.string().optional().openapi({ description: "Page number (default: 1)" }),
  limit: z.string().optional().openapi({ description: "Items per page (default: 25, max: 50)" }),
});

/**
 * Capped at 50, lower than the usual 100.
 *
 * The list route reads every listed tender's requirements in one `IN (...)`,
 * and D1 allows 100 bound parameters per query. 50 leaves room for the rest of
 * the statement without the page size and the database limit being the same
 * number, which is the kind of coincidence that breaks the first time either
 * one moves.
 */
function paginate(q: { page?: string; limit?: string }): { limit: number; offset: number; page: number } {
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

function ok<T extends z.ZodTypeAny>(description: string, schema: T) {
  return { description, content: { "application/json": { schema } } };
}
function fail(description: string) {
  return { description, content: { "application/json": { schema: ErrorSchema } } };
}

const FAMILIES = ["economic", "technical", "professional", "legal", "social_value", "other"] as const;
const OBLIGATIONS = ["mandatory", "scored", "optional"] as const;
/** What a caller may assert. `rejected` is the app's verdict on a citation, never the agent's claim. */
const CLAIMABLE = ["met", "not_met", "unknown", "not_stated"] as const;

const TenderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    buyer: z.string(),
    reference: z.string(),
    lot: z.string(),
    value: z.string(),
    currency: z.string(),
    deadline_at: z.string(),
    clarification_deadline_at: z.string(),
    source_url: z.string(),
    pack_id: z.string(),
    status: z.string(),
    decision_note: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("Tender");

const DocumentSchema = z
  .object({
    id: z.string(),
    tender_id: z.string(),
    name: z.string(),
    kind: z.string(),
    mime: z.string(),
    size_bytes: z.number().int(),
    page_count: z.number().int(),
    locator_kind: z.string(),
    extract_status: z.string(),
    extract_error: z.string(),
    created_at: z.string(),
  })
  .openapi("Document");

const FindingSchema = z
  .object({
    document_id: z.string().nullable(),
    stated: z.string(),
    quote: z.string(),
    page_no: z.number().int().nullable(),
    status: z.string(),
    our_evidence: z.string(),
    rationale: z.string(),
    rejected_reason: z.string(),
    updated_at: z.string(),
  })
  .openapi("Finding");

const RequirementSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    label: z.string(),
    family: z.string(),
    obligation: z.string(),
    weighting: z.string(),
    hint: z.string(),
    capability_key: z.string(),
    position: z.number().int(),
    finding: FindingSchema.nullable(),
  })
  .openapi("Requirement");

const CapabilitySchema = z
  .object({
    key: z.string(),
    label: z.string(),
    category: z.string(),
    value: z.string(),
    evidence: z.string(),
    expires_at: z.string(),
    notes: z.string(),
    updated_at: z.string(),
  })
  .openapi("Capability");

const VerdictSchema = z
  .object({
    verdict: z.string().openapi({ description: "go | no_go | blocked | unknown" }),
    reason: z.string(),
    blockers: z.array(z.object({ key: z.string(), label: z.string(), stated: z.string(), our_evidence: z.string() })),
    open_questions: z.array(z.object({ key: z.string(), label: z.string(), reason: z.string() })),
    families: z.array(
      z.object({ family: z.string(), met: z.number().int(), total: z.number().int(), state: z.string() }),
    ),
    scored: z.object({ answered: z.number().int(), total: z.number().int() }),
    days_to_deadline: z.number().int().nullable(),
    days_to_clarification_deadline: z.number().int().nullable(),
  })
  .openapi("Verdict");

// ── Helpers ──────────────────────────────────────────────────────────

const uid = () => crypto.randomUUID();

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  const row = await get<{ n: number }>(sql, params);
  return Number(row?.n ?? 0);
}

/**
 * Write a document's pages in as few statements as the database allows.
 *
 * One INSERT per page is the obvious loop and it fails in production only —
 * D1 caps a Worker invocation at 1000 queries, and a 400-page ITT pack sits
 * right against that ceiling while the local SQLite used in development
 * enforces no such limit.
 *
 * Both chunk bounds are D1 limits, not guesses: 100 bound parameters per query
 * (3 per row → 33 rows), and a cap on how much payload one statement carries.
 */
const MAX_ROWS_PER_INSERT = 33;
const MAX_BYTES_PER_INSERT = 900_000;
/** D1's maximum row size is 2 MB; leave room for the rest of the row. */
const MAX_PAGE_CHARS = 1_800_000;

async function insertPages(docId: string, pages: { page_no: number; text: string }[]) {
  let batch: { page_no: number; text: string }[] = [];
  let bytes = 0;

  const flush = async () => {
    if (!batch.length) return;
    const values = batch.map(() => "(?, ?, ?)").join(", ");
    await run(
      `INSERT INTO document_pages (document_id, page_no, text) VALUES ${values}`,
      batch.flatMap((p) => [docId, p.page_no, p.text]),
    );
    batch = [];
    bytes = 0;
  };

  for (const page of pages) {
    const text = page.text.length > MAX_PAGE_CHARS ? page.text.slice(0, MAX_PAGE_CHARS) : page.text;
    if (batch.length >= MAX_ROWS_PER_INSERT || bytes + text.length > MAX_BYTES_PER_INSERT) {
      await flush();
    }
    batch.push({ page_no: page.page_no, text });
    bytes += text.length;
  }
  await flush();
}

async function tenderOr404(id: string) {
  return get<{ id: string; name: string }>("SELECT id, name FROM tenders WHERE id = ?", [id]);
}

async function pagesOf(documentId: string): Promise<PageText[]> {
  return query<PageText>("SELECT page_no, text FROM document_pages WHERE document_id = ? ORDER BY page_no", [
    documentId,
  ]);
}

interface JoinedRequirement extends RequirementRow {
  id: string;
  weighting: string;
  hint: string;
  capability_key: string;
  position: number;
  finding: {
    document_id: string | null;
    stated: string;
    quote: string;
    page_no: number | null;
    status: string;
    our_evidence: string;
    rationale: string;
    rejected_reason: string;
    updated_at: string;
  } | null;
}

/**
 * A tender's requirements with each one's finding attached.
 *
 * One LEFT JOIN rather than a query per row: the schema holds exactly one
 * finding per requirement, so the join cannot fan out, and the alternative is
 * N+1 against a database that counts queries.
 */
async function requirementsOf(tenderId: string): Promise<JoinedRequirement[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT r.id, r.key, r.label, r.family, r.obligation, r.weighting, r.hint,
            r.capability_key, r.position,
            f.document_id, f.stated, f.quote, f.page_no, f.status,
            f.our_evidence, f.rationale, f.rejected_reason, f.updated_at AS finding_updated_at
       FROM requirements r
       LEFT JOIN findings f ON f.requirement_id = r.id
      WHERE r.tender_id = ?
      ORDER BY r.position, r.key`,
    [tenderId],
  );

  return rows.map((row) => ({
    id: String(row.id),
    key: String(row.key),
    label: String(row.label),
    family: String(row.family),
    obligation: String(row.obligation),
    weighting: String(row.weighting ?? ""),
    hint: String(row.hint ?? ""),
    capability_key: String(row.capability_key ?? ""),
    position: Number(row.position ?? 0),
    finding:
      row.status == null
        ? null
        : {
            document_id: (row.document_id as string | null) ?? null,
            stated: String(row.stated ?? ""),
            quote: String(row.quote ?? ""),
            page_no: row.page_no == null ? null : Number(row.page_no),
            status: String(row.status),
            our_evidence: String(row.our_evidence ?? ""),
            rationale: String(row.rationale ?? ""),
            rejected_reason: String(row.rejected_reason ?? ""),
            updated_at: String(row.finding_updated_at ?? ""),
          },
  }));
}

function findingRows(requirements: JoinedRequirement[]): FindingRow[] {
  return requirements
    .filter((r) => r.finding)
    .map((r) => ({
      requirement_key: r.key,
      status: r.finding!.status,
      stated: r.finding!.stated,
      our_evidence: r.finding!.our_evidence,
      rejected_reason: r.finding!.rejected_reason,
      page_no: r.finding!.page_no,
    }));
}

function verdictOf(
  tender: { deadline_at: string; clarification_deadline_at: string },
  requirements: JoinedRequirement[],
) {
  return {
    ...buildVerdict(requirements, findingRows(requirements)),
    days_to_deadline: daysUntil(tender.deadline_at),
    days_to_clarification_deadline: daysUntil(tender.clarification_deadline_at),
  };
}

/** `annual_turnover` → "Annual turnover". Derived, so no label is invented. */
function humanise(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

// ── Tenders ──────────────────────────────────────────────────────────

const listTenders = createRoute({
  method: "get",
  path: "/api/tenders",
  tags: ["Tenders"],
  summary: "List tenders with their current verdict, soonest deadline first",
  description:
    "The verdict on each row is computed from the findings at read time, exactly like the one on the detail route — there is no stored copy that could disagree with it.",
  request: {
    query: PaginationQuery.extend({
      search: z.string().optional().openapi({ description: "Free-text match on name, buyer or reference" }),
      status: z.enum(["open", "submitted", "abandoned", "won", "lost"]).optional(),
    }),
  },
  responses: {
    200: ok(
      "A page of tenders",
      z.object({
        tenders: z.array(
          TenderSchema.extend({
            document_count: z.number().int(),
            requirement_count: z.number().int(),
            verdict: z.string(),
            reason: z.string(),
            days_to_deadline: z.number().int().nullable(),
          }),
        ),
        total: z.number().int(),
        page: z.number().int(),
      }),
    ),
  },
});

app.openapi(listTenders, async (c) => {
  const q = c.req.valid("query");
  const { limit, offset, page } = paginate(q);

  const where: string[] = [];
  const params: unknown[] = [];
  if (q.search) {
    where.push("(name LIKE ? OR buyer LIKE ? OR reference LIKE ?)");
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  if (q.status) {
    where.push("status = ?");
    params.push(q.status);
  }
  const whereSQL = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const tenders = await query<Record<string, unknown>>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM documents d WHERE d.tender_id = t.id)    AS document_count,
            (SELECT COUNT(*) FROM requirements r WHERE r.tender_id = t.id) AS requirement_count
       FROM tenders t${whereSQL}
      -- An empty deadline sorts last rather than first: a tender with no date
      -- is not the most urgent thing on the board, it is the least known.
      ORDER BY (t.deadline_at = '') ASC, t.deadline_at ASC, t.created_at DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = await countOf(`SELECT COUNT(*) AS n FROM tenders${whereSQL}`, params);

  const ids = tenders.map((t) => String(t.id));
  const byTender = await requirementsByTender(ids);

  const withVerdict = tenders.map((t) => {
    const requirements = byTender.get(String(t.id)) ?? [];
    const report = buildVerdict(requirements, findingRows(requirements));
    return {
      ...t,
      verdict: report.verdict,
      reason: report.reason,
      days_to_deadline: daysUntil(String(t.deadline_at ?? "")),
    };
  });

  return c.json({ tenders: withVerdict, total, page } as never);
});

/** Every listed tender's requirements in two queries rather than two per row. */
async function requirementsByTender(ids: string[]): Promise<Map<string, JoinedRequirement[]>> {
  const out = new Map<string, JoinedRequirement[]>();
  if (ids.length === 0) return out;

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await query<Record<string, unknown>>(
    `SELECT r.tender_id, r.key, r.label, r.family, r.obligation,
            f.status, f.stated, f.our_evidence, f.rejected_reason, f.page_no
       FROM requirements r
       LEFT JOIN findings f ON f.requirement_id = r.id
      WHERE r.tender_id IN (${placeholders})`,
    ids,
  );

  for (const row of rows) {
    const tenderId = String(row.tender_id);
    const list = out.get(tenderId) ?? [];
    list.push({
      id: "",
      key: String(row.key),
      label: String(row.label),
      family: String(row.family),
      obligation: String(row.obligation),
      weighting: "",
      hint: "",
      capability_key: "",
      position: 0,
      finding:
        row.status == null
          ? null
          : {
              document_id: null,
              stated: String(row.stated ?? ""),
              quote: "",
              page_no: row.page_no == null ? null : Number(row.page_no),
              status: String(row.status),
              our_evidence: String(row.our_evidence ?? ""),
              rationale: "",
              rejected_reason: String(row.rejected_reason ?? ""),
              updated_at: "",
            },
    });
    out.set(tenderId, list);
  }
  return out;
}

const createTender = createRoute({
  method: "post",
  path: "/api/tenders",
  tags: ["Tenders"],
  summary: "Open a tender, optionally seeded with a requirement pack",
  description:
    "Passing pack_id copies that pack's requirements onto the tender and creates any capability rows they point at, so the profile page has something to fill in. Without it the tender starts empty and requirements are added by hand.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            buyer: z.string().optional(),
            reference: z.string().optional(),
            lot: z.string().optional(),
            value: z.string().optional(),
            currency: z.string().optional(),
            deadline_at: z.string().optional().openapi({ description: "ISO date or datetime" }),
            clarification_deadline_at: z.string().optional(),
            source_url: z.string().optional(),
            pack_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: ok("The new tender", TenderSchema.extend({ requirements_added: z.number().int() })),
    400: fail("No such pack"),
  },
});

app.openapi(createTender, async (c) => {
  const body = c.req.valid("json");
  if (body.pack_id && !findPack(body.pack_id)) {
    return c.json({ error: `No pack with id "${body.pack_id}"` } as never, 400);
  }

  const id = uid();
  await run(
    `INSERT INTO tenders (id, name, buyer, reference, lot, value, currency,
                          deadline_at, clarification_deadline_at, source_url, pack_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.buyer ?? "",
      body.reference ?? "",
      body.lot ?? "",
      body.value ?? "",
      body.currency ?? "GBP",
      body.deadline_at ?? "",
      body.clarification_deadline_at ?? "",
      body.source_url ?? "",
      body.pack_id ?? "",
      user(c)?.id ?? "",
    ],
  );

  const added = body.pack_id ? await applyPack(id, body.pack_id) : 0;
  const tender = await get<Record<string, unknown>>("SELECT * FROM tenders WHERE id = ?", [id]);
  return c.json({ ...tender, requirements_added: added } as never, 201);
});

const getTender = createRoute({
  method: "get",
  path: "/api/tenders/{id}",
  tags: ["Tenders"],
  summary: "The tender, its requirements, our capability profile, and the verdict",
  description:
    "Start here. Each requirement carries the hint saying what to look for and, once answered, its finding. The capability profile is what a finding's status is judged against — `met` is a claim about us, not about the tender.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: ok(
      "The tender in full",
      z.object({
        tender: TenderSchema,
        requirements: z.array(RequirementSchema),
        capabilities: z.array(CapabilitySchema),
        verdict: VerdictSchema,
        document_count: z.number().int(),
      }),
    ),
    404: fail("No such tender"),
  },
});

app.openapi(getTender, async (c) => {
  const { id } = c.req.valid("param");
  const tender = await get<Record<string, unknown>>("SELECT * FROM tenders WHERE id = ?", [id]);
  if (!tender) return c.json({ error: "No such tender" } as never, 404);

  const requirements = await requirementsOf(id);
  const capabilities = await query<Record<string, unknown>>("SELECT * FROM capabilities ORDER BY category, key");
  const document_count = await countOf("SELECT COUNT(*) AS n FROM documents WHERE tender_id = ?", [id]);

  return c.json({
    tender,
    requirements,
    capabilities,
    verdict: verdictOf(
      {
        deadline_at: String(tender.deadline_at ?? ""),
        clarification_deadline_at: String(tender.clarification_deadline_at ?? ""),
      },
      requirements,
    ),
    document_count,
  } as never);
});

const getVerdict = createRoute({
  method: "get",
  path: "/api/tenders/{id}/verdict",
  tags: ["Tenders"],
  summary: "Just the bid/no-bid call",
  description: "The same computation as the detail route, without the rows — for polling while the agent works.",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: ok("The verdict", VerdictSchema), 404: fail("No such tender") },
});

app.openapi(getVerdict, async (c) => {
  const { id } = c.req.valid("param");
  const tender = await get<{ deadline_at: string; clarification_deadline_at: string }>(
    "SELECT deadline_at, clarification_deadline_at FROM tenders WHERE id = ?",
    [id],
  );
  if (!tender) return c.json({ error: "No such tender" } as never, 404);
  return c.json(verdictOf(tender, await requirementsOf(id)) as never);
});

const updateTender = createRoute({
  method: "patch",
  path: "/api/tenders/{id}",
  tags: ["Tenders"],
  summary: "Edit a tender, or record the decision a human actually made",
  description:
    "`status` and `decision_note` are the override. The computed verdict is evidence, not authority: a team that bids anyway, or walks away from a technical go, records why here rather than editing the findings until the machine agrees with them.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).optional(),
            buyer: z.string().optional(),
            reference: z.string().optional(),
            lot: z.string().optional(),
            value: z.string().optional(),
            currency: z.string().optional(),
            deadline_at: z.string().optional(),
            clarification_deadline_at: z.string().optional(),
            source_url: z.string().optional(),
            status: z.enum(["open", "submitted", "abandoned", "won", "lost"]).optional(),
            decision_note: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: ok("The updated tender", TenderSchema), 404: fail("No such tender") },
});

app.openapi(updateTender, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await tenderOr404(id))) return c.json({ error: "No such tender" } as never, 404);

  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length) {
    await run(`UPDATE tenders SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`, [...params, id]);
  }

  const tender = await get<Record<string, unknown>>("SELECT * FROM tenders WHERE id = ?", [id]);
  return c.json(tender as never);
});

const deleteTender = createRoute({
  method: "delete",
  path: "/api/tenders/{id}",
  tags: ["Tenders"],
  summary: "Delete a tender, its documents, requirements and findings",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: ok("Deleted", OkSchema), 404: fail("No such tender") },
});

app.openapi(deleteTender, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await tenderOr404(id))) return c.json({ error: "No such tender" } as never, 404);

  // The rows cascade; the stored files do not, so they are removed explicitly
  // rather than left paying for themselves in a bucket nobody can reach.
  const docs = await query<{ r2_key: string }>("SELECT r2_key FROM documents WHERE tender_id = ?", [id]);
  for (const doc of docs) {
    if (doc.r2_key) await c.env.UPLOADS.delete(doc.r2_key);
  }
  await run("DELETE FROM tenders WHERE id = ?", [id]);
  return c.json({ ok: true } as never);
});

// ── Packs ────────────────────────────────────────────────────────────

const listPacks = createRoute({
  method: "get",
  path: "/api/packs",
  tags: ["Packs"],
  summary: "The bundled requirement packs",
  description: "Shape only. Fetch one pack to see its requirements.",
  responses: {
    200: ok(
      "The catalogue",
      z.object({
        packs: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            description: z.string(),
            jurisdiction: z.string(),
            requirement_count: z.number().int(),
            mandatory_count: z.number().int(),
            publisher: z.string(),
            licence: z.string(),
            source_url: z.string(),
          }),
        ),
      }),
    ),
  },
});

app.openapi(listPacks, async (c) => c.json({ packs: catalogue() } as never));

const getPack = createRoute({
  method: "get",
  path: "/api/packs/{id}",
  tags: ["Packs"],
  summary: "One pack, with its requirements and its provenance",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: ok("The pack", z.any()), 404: fail("No such pack") },
});

app.openapi(getPack, async (c) => {
  const pack = findPack(c.req.valid("param").id);
  if (!pack) return c.json({ error: "No such pack" } as never, 404);
  return c.json(pack as never);
});

const applyPackRoute = createRoute({
  method: "post",
  path: "/api/tenders/{id}/pack",
  tags: ["Packs"],
  summary: "Copy a pack's requirements onto a tender",
  description:
    "Copies, so the rows become the tender's own: editing them later cannot be undone by a bundle update, and an old tender's decision stays the decision that was actually made. Requirements whose key is already on the tender are left alone, which makes this safe to re-run.",
  request: {
    params: z.object({ id: z.string() }),
    body: { content: { "application/json": { schema: z.object({ pack_id: z.string() }) } } },
  },
  responses: {
    200: ok("What was copied", z.object({ added: z.number().int(), skipped: z.number().int() })),
    404: fail("No such tender or pack"),
  },
});

app.openapi(applyPackRoute, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await tenderOr404(id))) return c.json({ error: "No such tender" } as never, 404);

  const { pack_id } = c.req.valid("json");
  const pack = findPack(pack_id);
  if (!pack) return c.json({ error: "No such pack" } as never, 404);

  const before = await countOf("SELECT COUNT(*) AS n FROM requirements WHERE tender_id = ?", [id]);
  const added = await applyPack(id, pack_id);
  await run("UPDATE tenders SET pack_id = ?, updated_at = datetime('now') WHERE id = ?", [pack_id, id]);

  return c.json({ added, skipped: pack.requirements.length - added, requirements_before: before } as never);
});

/**
 * Copy a pack onto a tender, and make sure the profile has a row for every
 * capability those requirements point at.
 *
 * The capability rows matter as much as the requirements. Without them the
 * profile page opens empty and the user has to guess key names that happen to
 * match what the pack expects — so the app would ship a checklist it gives you
 * no way to answer. The rows are created blank: a blank value is an honest
 * "nobody has said yet", and the verdict reads it as unresolved rather than as
 * a pass.
 */
async function applyPack(tenderId: string, packId: string): Promise<number> {
  const pack = findPack(packId);
  if (!pack) return 0;

  const existing = new Set(
    (await query<{ key: string }>("SELECT key FROM requirements WHERE tender_id = ?", [tenderId])).map((r) => r.key),
  );
  const heldCapabilities = new Set(
    (await query<{ key: string }>("SELECT key FROM capabilities")).map((r) => r.key),
  );

  let added = 0;
  let position = await countOf("SELECT COUNT(*) AS n FROM requirements WHERE tender_id = ?", [tenderId]);

  for (const req of pack.requirements) {
    if (existing.has(req.key)) continue;

    await run(
      `INSERT INTO requirements (id, tender_id, position, key, label, family, obligation, weighting, hint, capability_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid(), tenderId, position++, req.key, req.label, req.family, req.obligation, "", req.hint, req.capability_key],
    );
    added++;

    if (req.capability_key && !heldCapabilities.has(req.capability_key)) {
      await run(
        `INSERT OR IGNORE INTO capabilities (key, label, category, value) VALUES (?, ?, ?, '')`,
        [req.capability_key, humanise(req.capability_key), req.family],
      );
      heldCapabilities.add(req.capability_key);
    }
  }
  return added;
}

// ── Requirements ─────────────────────────────────────────────────────

const addRequirement = createRoute({
  method: "post",
  path: "/api/tenders/{id}/requirements",
  tags: ["Requirements"],
  summary: "Add a requirement this buyer imposes and the pack does not",
  description:
    "For the conditions a specific buyer writes themselves. The pack is a starting point, not the tender: anything it does not cover goes in here, and anything it covers that this tender does not ask for gets deleted.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            key: z.string().min(1).openapi({ description: "Stable handle the agent writes findings against" }),
            label: z.string().min(1),
            family: z.enum(FAMILIES).optional(),
            obligation: z.enum(OBLIGATIONS).optional(),
            weighting: z.string().optional(),
            hint: z.string().optional(),
            capability_key: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: ok("The new requirement", RequirementSchema),
    404: fail("No such tender"),
    409: fail("That key is already on this tender"),
  },
});

app.openapi(addRequirement, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await tenderOr404(id))) return c.json({ error: "No such tender" } as never, 404);

  const body = c.req.valid("json");
  const clash = await get<{ id: string }>("SELECT id FROM requirements WHERE tender_id = ? AND key = ?", [
    id,
    body.key,
  ]);
  if (clash) return c.json({ error: `This tender already has a requirement keyed "${body.key}"` } as never, 409);

  const reqId = uid();
  const position = await countOf("SELECT COUNT(*) AS n FROM requirements WHERE tender_id = ?", [id]);
  await run(
    `INSERT INTO requirements (id, tender_id, position, key, label, family, obligation, weighting, hint, capability_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      reqId,
      id,
      position,
      body.key,
      body.label,
      body.family ?? "other",
      body.obligation ?? "mandatory",
      body.weighting ?? "",
      body.hint ?? "",
      body.capability_key ?? "",
    ],
  );

  if (body.capability_key) {
    await run(`INSERT OR IGNORE INTO capabilities (key, label, category, value) VALUES (?, ?, ?, '')`, [
      body.capability_key,
      humanise(body.capability_key),
      body.family ?? "other",
    ]);
  }

  const row = (await requirementsOf(id)).find((r) => r.id === reqId);
  return c.json(row as never, 201);
});

const updateRequirement = createRoute({
  method: "patch",
  path: "/api/requirements/{id}",
  tags: ["Requirements"],
  summary: "Re-grade or reword a requirement",
  description:
    "Mostly used to move a row between mandatory and scored once someone has actually read the tender. That is a judgment call with a real consequence — only mandatory rows can produce a no-go — so it is an edit, not a delete and re-add, and the finding underneath survives it.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            label: z.string().min(1).optional(),
            family: z.enum(FAMILIES).optional(),
            obligation: z.enum(OBLIGATIONS).optional(),
            weighting: z.string().optional(),
            hint: z.string().optional(),
            capability_key: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: ok("The updated requirement", RequirementSchema), 404: fail("No such requirement") },
});

app.openapi(updateRequirement, async (c) => {
  const { id } = c.req.valid("param");
  const existing = await get<{ id: string; tender_id: string }>(
    "SELECT id, tender_id FROM requirements WHERE id = ?",
    [id],
  );
  if (!existing) return c.json({ error: "No such requirement" } as never, 404);

  const body = c.req.valid("json");
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(value);
  }
  if (sets.length) await run(`UPDATE requirements SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);

  const row = (await requirementsOf(existing.tender_id)).find((r) => r.id === id);
  return c.json(row as never);
});

const deleteRequirement = createRoute({
  method: "delete",
  path: "/api/requirements/{id}",
  tags: ["Requirements"],
  summary: "Remove a requirement this tender does not impose",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: ok("Deleted", OkSchema), 404: fail("No such requirement") },
});

app.openapi(deleteRequirement, async (c) => {
  const { id } = c.req.valid("param");
  const existing = await get<{ id: string }>("SELECT id FROM requirements WHERE id = ?", [id]);
  if (!existing) return c.json({ error: "No such requirement" } as never, 404);
  await run("DELETE FROM requirements WHERE id = ?", [id]);
  return c.json({ ok: true } as never);
});

// ── Our capability profile ───────────────────────────────────────────

const listCapabilities = createRoute({
  method: "get",
  path: "/api/capabilities",
  tags: ["Capabilities"],
  summary: "What this company can evidence",
  description:
    "Answered once and reused for every tender. This is the half of the decision that is about us, which is why it does not live under a tender.",
  responses: { 200: ok("The profile", z.object({ capabilities: z.array(CapabilitySchema) })) },
});

app.openapi(listCapabilities, async (c) =>
  c.json({
    capabilities: await query<Record<string, unknown>>("SELECT * FROM capabilities ORDER BY category, key"),
  } as never),
);

const putCapability = createRoute({
  method: "put",
  path: "/api/capabilities/{key}",
  tags: ["Capabilities"],
  summary: "Record or update one capability",
  description:
    "`expires_at` is the one people skip and then regret: a certificate that lapses mid-procurement fails the same requirement it passed last month.",
  request: {
    params: z.object({ key: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            label: z.string().optional(),
            category: z.enum(FAMILIES).optional(),
            value: z.string().optional().openapi({ description: '"GBP 1.8m", "held", "3 contracts"' }),
            evidence: z.string().optional().openapi({ description: "Where a human can go and check" }),
            expires_at: z.string().optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: { 200: ok("The capability", CapabilitySchema) },
});

app.openapi(putCapability, async (c) => {
  const { key } = c.req.valid("param");
  const body = c.req.valid("json");

  await run(
    `INSERT INTO capabilities (key, label, category, value, evidence, expires_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       label = excluded.label, category = excluded.category, value = excluded.value,
       evidence = excluded.evidence, expires_at = excluded.expires_at, notes = excluded.notes,
       updated_at = datetime('now')`,
    [
      key,
      body.label ?? humanise(key),
      body.category ?? "other",
      body.value ?? "",
      body.evidence ?? "",
      body.expires_at ?? "",
      body.notes ?? "",
    ],
  );

  const row = await get<Record<string, unknown>>("SELECT * FROM capabilities WHERE key = ?", [key]);
  return c.json(row as never);
});

const deleteCapability = createRoute({
  method: "delete",
  path: "/api/capabilities/{key}",
  tags: ["Capabilities"],
  summary: "Remove a capability from the profile",
  request: { params: z.object({ key: z.string() }) },
  responses: { 200: ok("Deleted", OkSchema) },
});

app.openapi(deleteCapability, async (c) => {
  await run("DELETE FROM capabilities WHERE key = ?", [c.req.valid("param").key]);
  return c.json({ ok: true } as never);
});

// ── Documents ────────────────────────────────────────────────────────

const listDocuments = createRoute({
  method: "get",
  path: "/api/tenders/{id}/documents",
  tags: ["Documents"],
  summary: "The tender pack",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: ok("The documents", z.object({ documents: z.array(DocumentSchema) })),
    404: fail("No such tender"),
  },
});

app.openapi(listDocuments, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await tenderOr404(id))) return c.json({ error: "No such tender" } as never, 404);
  const documents = await query<Record<string, unknown>>(
    "SELECT id, tender_id, name, kind, mime, size_bytes, page_count, locator_kind, extract_status, extract_error, created_at FROM documents WHERE tender_id = ? ORDER BY created_at",
    [id],
  );
  return c.json({ documents } as never);
});

const uploadDocument = createRoute({
  method: "post",
  path: "/api/tenders/{id}/documents",
  tags: ["Documents"],
  summary: "Upload a tender document and extract its text",
  description:
    "Accepts PDF, DOCX and plain text. Text is extracted synchronously and stored page by page — until extract_status is 'ready', no citation against this document can be verified. `kind` tells the agent how to read it: selection criteria live in the SQ, deliverables in the specification, and the penalties are usually only in the contract.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
            kind: z.string().optional().openapi({ description: "itt | specification | sq | contract | pricing | other" }),
          }),
        },
      },
    },
  },
  responses: {
    201: ok("The stored document", DocumentSchema),
    404: fail("No such tender"),
    415: fail("The file has no text layer we can read"),
  },
});

app.openapi(uploadDocument, async (c) => {
  const { id } = c.req.valid("param");
  if (!(await tenderOr404(id))) return c.json({ error: "No such tender" } as never, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "No file in the request" } as never, 415);

  const kindField = form.get("kind");
  const kind = typeof kindField === "string" && kindField ? kindField : "other";
  const mime = file.type || "";

  // Rejected on the filename before a byte is stored — a caller uploading a
  // scan should not wait for a round trip to hear it cannot be read.
  if (!isSupported(file.name, mime)) {
    return c.json(
      {
        error: `${file.name}: only PDF, DOCX and plain text can be read. Legacy .doc and scanned images have no text layer — convert to PDF (with OCR if scanned) and upload that.`,
      } as never,
      415,
    );
  }

  const docId = uid();
  const r2Key = `documents/${id}/${docId}`;
  const bytes = await file.arrayBuffer();
  await c.env.UPLOADS.put(r2Key, bytes, { httpMetadata: { contentType: mime || "application/octet-stream" } });

  await run(
    `INSERT INTO documents (id, tender_id, name, kind, r2_key, mime, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [docId, id, file.name, kind, r2Key, mime, bytes.byteLength],
  );

  await extractInto(docId, file.name, mime, bytes);

  const doc = await get<Record<string, unknown>>("SELECT * FROM documents WHERE id = ?", [docId]);
  return c.json(doc as never, 201);
});

const extractDocument = createRoute({
  method: "post",
  path: "/api/documents/{id}/extract",
  tags: ["Documents"],
  summary: "Read a pending document's text",
  description:
    "The second half of an upload. Idempotent: a document that is already ready is returned untouched, so a retry after a dropped connection costs nothing.",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: ok("The document, now ready or failed", DocumentSchema), 404: fail("No such document") },
});

app.openapi(extractDocument, async (c) => {
  const { id } = c.req.valid("param");
  const doc = await get<{ id: string; name: string; mime: string; r2_key: string; extract_status: string }>(
    "SELECT id, name, mime, r2_key, extract_status FROM documents WHERE id = ?",
    [id],
  );
  if (!doc) return c.json({ error: "No such document" } as never, 404);

  if (doc.extract_status !== "ready") {
    const object = await c.env.UPLOADS.get(doc.r2_key);
    if (!object) {
      await run("UPDATE documents SET extract_status = 'failed', extract_error = ? WHERE id = ?", [
        "the stored file is missing",
        id,
      ]);
    } else {
      await extractInto(id, doc.name, doc.mime, await object.arrayBuffer());
    }
  }

  const updated = await get<Record<string, unknown>>("SELECT * FROM documents WHERE id = ?", [id]);
  return c.json(updated as never);
});

/** Extract and store, recording the failure rather than throwing it at the caller. */
async function extractInto(docId: string, name: string, mime: string, bytes: ArrayBuffer) {
  try {
    const { pages, locatorKind } = await extract(bytes, name, mime);
    // Re-runnable: a retry after a partial write must not double the pages.
    await run("DELETE FROM document_pages WHERE document_id = ?", [docId]);
    await insertPages(docId, pages);
    await run(
      "UPDATE documents SET page_count = ?, locator_kind = ?, extract_status = 'ready', extract_error = '' WHERE id = ?",
      [pages.length, locatorKind, docId],
    );
  } catch (err) {
    // The file is kept: a failed extraction is recoverable (re-run OCR and
    // re-upload), and deleting the user's upload on our failure is not our call.
    const message =
      err instanceof UnsupportedFileError ? err.message : `Extraction failed: ${(err as Error).message}`;
    await run("UPDATE documents SET extract_status = 'failed', extract_error = ? WHERE id = ?", [
      message.slice(0, 500),
      docId,
    ]);
  }
}

const getDocumentPages = createRoute({
  method: "get",
  path: "/api/documents/{id}/pages",
  tags: ["Documents"],
  summary: "Read a document's extracted text, one page at a time",
  description:
    "This is how you read a document. Paginated because a 300-page ITT would otherwise bury the caller in text — read every page before answering, not just the first. The selection criteria are rarely where you expect them.",
  request: {
    params: z.object({ id: z.string() }),
    query: PaginationQuery.extend({
      from_page: z.string().optional().openapi({ description: "Start at this page number" }),
    }),
  },
  responses: {
    200: ok(
      "A page of pages",
      z.object({
        document: z.object({
          id: z.string(),
          name: z.string(),
          kind: z.string(),
          page_count: z.number().int(),
          locator_kind: z.string(),
        }),
        pages: z.array(z.object({ page_no: z.number().int(), text: z.string() })),
        total: z.number().int(),
        page: z.number().int(),
      }),
    ),
    404: fail("No such document"),
  },
});

app.openapi(getDocumentPages, async (c) => {
  const { id } = c.req.valid("param");
  const q = c.req.valid("query");
  const doc = await get<{ id: string; name: string; kind: string; page_count: number; locator_kind: string }>(
    "SELECT id, name, kind, page_count, locator_kind FROM documents WHERE id = ?",
    [id],
  );
  if (!doc) return c.json({ error: "No such document" } as never, 404);

  // Default to 5 pages: enough to keep a read moving, small enough that a
  // careless caller doesn't pull a whole pack into one response.
  const limit = Math.min(50, Math.max(1, Number(q.limit) || 5));
  const from = Number(q.from_page) || 0;
  const offset = from > 0 ? 0 : (Math.max(1, Number(q.page) || 1) - 1) * limit;
  const where = from > 0 ? "AND page_no >= ?" : "";
  const params = from > 0 ? [id, from, limit] : [id, limit, offset];

  const pages = await query<{ page_no: number; text: string }>(
    `SELECT page_no, text FROM document_pages WHERE document_id = ? ${where} ORDER BY page_no LIMIT ?${
      from > 0 ? "" : " OFFSET ?"
    }`,
    params,
  );

  return c.json({ document: doc, pages, total: doc.page_count, page: Math.max(1, Number(q.page) || 1) } as never);
});

const getDocumentFile = createRoute({
  method: "get",
  path: "/api/documents/{id}/file",
  tags: ["Documents"],
  summary: "Open the original file",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { description: "The stored file", content: { "application/octet-stream": { schema: z.any() } } },
    404: fail("No such document"),
  },
});

app.openapi(getDocumentFile, async (c) => {
  const { id } = c.req.valid("param");
  const doc = await get<{ r2_key: string; mime: string; name: string }>(
    "SELECT r2_key, mime, name FROM documents WHERE id = ?",
    [id],
  );
  if (!doc) return c.json({ error: "No such document" } as never, 404);

  const obj = await c.env.UPLOADS.get(doc.r2_key);
  if (!obj) return c.json({ error: "The stored file is missing" } as never, 404);

  return new Response(obj.body, {
    headers: {
      "Content-Type": doc.mime || "application/octet-stream",
      // inline: the point is to read the cited page beside the finding, not to
      // download the pack again.
      "Content-Disposition": `inline; filename="${doc.name.replace(/"/g, "")}"`,
    },
  }) as never;
});

const deleteDocument = createRoute({
  method: "delete",
  path: "/api/documents/{id}",
  tags: ["Documents"],
  summary: "Remove a document and its extracted text",
  description:
    "Findings that cited it keep their quote and page but lose the link, so the evidence trail says 'this came from a document that has since been removed' rather than silently disappearing.",
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: ok("Deleted", OkSchema), 404: fail("No such document") },
});

app.openapi(deleteDocument, async (c) => {
  const { id } = c.req.valid("param");
  const doc = await get<{ r2_key: string }>("SELECT r2_key FROM documents WHERE id = ?", [id]);
  if (!doc) return c.json({ error: "No such document" } as never, 404);

  if (doc.r2_key) await c.env.UPLOADS.delete(doc.r2_key);
  await run("DELETE FROM documents WHERE id = ?", [id]);
  return c.json({ ok: true } as never);
});

// ── Findings: the verified write ─────────────────────────────────────

const putFindings = createRoute({
  method: "post",
  path: "/api/tenders/{id}/findings",
  tags: ["Findings"],
  summary: "Submit findings — every quote is checked against the document text",
  description:
    "A finding answers two separate questions. `stated` is what the BUYER demands, quoted verbatim from their document; `status` is whether WE meet it, judged against the capability profile. Every status except 'not_stated' must carry a quote, which is located in the extracted text before the finding is stored; a quote that cannot be found is saved as 'rejected' and shown to the user as unresolved, never as an answer. Accepted findings persist when others are rejected, so a retry only needs to re-send the failures.",
  request: {
    params: z.object({ id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            findings: z
              .array(
                z.object({
                  requirement: z.string().openapi({ description: "The requirement's key, e.g. cyber_essentials" }),
                  status: z.enum(CLAIMABLE),
                  document_id: z.string().optional().openapi({ description: "Required unless status is not_stated" }),
                  stated: z.string().optional().openapi({ description: "The threshold as the buyer words it" }),
                  quote: z.string().optional().openapi({ description: "Verbatim text from the document" }),
                  page: z.number().int().optional().openapi({ description: "Page the quote appears on" }),
                  our_evidence: z.string().optional().openapi({ description: "The capability value this was judged against" }),
                  rationale: z.string().optional(),
                }),
              )
              .min(1)
              .max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: ok(
      "Every finding was accepted",
      z.object({
        accepted: z.number().int(),
        rejected: z.array(
          z.object({ requirement: z.string(), reason: z.string(), found_on_page: z.number().int().optional() }),
        ),
        verdict: VerdictSchema,
      }),
    ),
    422: ok("At least one finding failed verification. The rest were stored.", z.any()),
    404: fail("No such tender"),
  },
});

app.openapi(putFindings, async (c) => {
  const { id } = c.req.valid("param");
  const tender = await get<{ id: string; deadline_at: string; clarification_deadline_at: string }>(
    "SELECT id, deadline_at, clarification_deadline_at FROM tenders WHERE id = ?",
    [id],
  );
  if (!tender) return c.json({ error: "No such tender" } as never, 404);

  const { findings } = c.req.valid("json");
  const requirements = await query<{ id: string; key: string }>(
    "SELECT id, key FROM requirements WHERE tender_id = ?",
    [id],
  );
  const byKey = new Map(requirements.map((r) => [r.key, r.id]));

  // Read each document's text at most once, however many findings cite it.
  const pageCache = new Map<string, PageText[]>();
  const pagesFor = async (documentId: string) => {
    const cached = pageCache.get(documentId);
    if (cached) return cached;
    const pages = await pagesOf(documentId);
    pageCache.set(documentId, pages);
    return pages;
  };

  const rejected: { requirement: string; reason: string; found_on_page?: number }[] = [];
  let accepted = 0;

  for (const finding of findings) {
    const requirementId = byKey.get(finding.requirement);
    if (!requirementId) {
      rejected.push({
        requirement: finding.requirement,
        reason: `no requirement with key "${finding.requirement}" on this tender (have: ${requirements
          .map((r) => r.key)
          .join(", ")})`,
      });
      continue;
    }

    // The honest escape hatch: this tender does not impose the requirement at
    // all. No quote, because there is nothing to quote — and the verdict reads
    // it as a hurdle that was never set rather than one we failed.
    if (finding.status === "not_stated") {
      await upsertFinding(requirementId, {
        document_id: null,
        stated: "",
        quote: "",
        page_no: null,
        status: "not_stated",
        our_evidence: "",
        rationale: finding.rationale ?? "",
        rejected_reason: "",
      });
      accepted++;
      continue;
    }

    if (!finding.document_id) {
      rejected.push({
        requirement: finding.requirement,
        reason: "document_id is required — a finding says which document the buyer states this in",
      });
      continue;
    }

    const belongs = await get<{ id: string }>("SELECT id FROM documents WHERE id = ? AND tender_id = ?", [
      finding.document_id,
      id,
    ]);
    if (!belongs) {
      rejected.push({
        requirement: finding.requirement,
        reason: "that document is not filed under this tender",
      });
      continue;
    }

    const verdict = verifyQuote(finding.quote ?? "", finding.page ?? null, await pagesFor(finding.document_id));
    if (!verdict.ok) {
      await upsertFinding(requirementId, {
        document_id: finding.document_id,
        stated: finding.stated ?? "",
        quote: finding.quote ?? "",
        page_no: finding.page ?? null,
        status: "rejected",
        our_evidence: finding.our_evidence ?? "",
        rationale: finding.rationale ?? "",
        rejected_reason: verdict.reason,
      });
      rejected.push({
        requirement: finding.requirement,
        reason: verdict.reason,
        ...(verdict.foundOnPage !== undefined ? { found_on_page: verdict.foundOnPage } : {}),
      });
      continue;
    }

    await upsertFinding(requirementId, {
      document_id: finding.document_id,
      stated: finding.stated ?? "",
      quote: finding.quote ?? "",
      page_no: verdict.page,
      status: finding.status,
      our_evidence: finding.our_evidence ?? "",
      rationale: finding.rationale ?? "",
      rejected_reason: "",
    });
    accepted++;
  }

  // Hand the verdict back with the receipt. The caller has just changed the
  // only thing it depends on, and the whole point of the app is the answer to
  // "can we bid" — making them ask again for it is a round trip for nothing.
  const report = verdictOf(tender, await requirementsOf(id));
  await run("UPDATE tenders SET updated_at = datetime('now') WHERE id = ?", [id]);

  return c.json({ accepted, rejected, verdict: report } as never, rejected.length ? 422 : 200);
});

async function upsertFinding(
  requirementId: string,
  data: {
    document_id: string | null;
    stated: string;
    quote: string;
    page_no: number | null;
    status: string;
    our_evidence: string;
    rationale: string;
    rejected_reason: string;
  },
) {
  await run(
    `INSERT INTO findings (id, requirement_id, document_id, stated, quote, page_no, status, our_evidence, rationale, rejected_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (requirement_id) DO UPDATE SET
       document_id = excluded.document_id, stated = excluded.stated, quote = excluded.quote,
       page_no = excluded.page_no, status = excluded.status, our_evidence = excluded.our_evidence,
       rationale = excluded.rationale, rejected_reason = excluded.rejected_reason,
       updated_at = datetime('now')`,
    [
      uid(),
      requirementId,
      data.document_id,
      data.stated,
      data.quote,
      data.page_no,
      data.status,
      data.our_evidence,
      data.rationale,
      data.rejected_reason,
    ],
  );
}

// ── The second read ──────────────────────────────────────────────────

const recheck = createRoute({
  method: "post",
  path: "/api/tenders/{id}/recheck",
  tags: ["Findings"],
  summary: "Re-read the pack for the requirements someone cleared as not asked for",
  description:
    "`not_stated` is the only status with no quote behind it, so it is the only way to clear a mandatory requirement on an assertion. This re-reads the documents for exactly those rows and returns the ones the text appears to impose after all, each with the page that says so. A flagged row is moved back to `unknown`: unresolved, never failed. Does nothing and reports `available: false` where no decision model is configured.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: ok(
      "What the second read found",
      z.object({
        available: z.boolean(),
        checked: z.number().int(),
        pages_read: z.number().int(),
        flagged: z.array(
          z.object({
            requirement: z.string(),
            label: z.string(),
            document_id: z.string(),
            document: z.string(),
            page_no: z.number().int(),
            probability: z.number(),
          }),
        ),
        verdict: VerdictSchema,
      }),
    ),
    404: fail("No such tender"),
  },
});

app.openapi(recheck, async (c) => {
  const { id } = c.req.valid("param");
  const tender = await get<{ id: string; deadline_at: string; clarification_deadline_at: string }>(
    "SELECT id, deadline_at, clarification_deadline_at FROM tenders WHERE id = ?",
    [id],
  );
  if (!tender) return c.json({ error: "No such tender" } as never, 404);

  const requirements = await requirementsOf(id);
  const cleared = requirements.filter((r) => r.finding?.status === "not_stated");

  // Nothing to do is a 200 with a reason, not an error. A deployment without a
  // decision model is missing a second opinion, which is not a broken tender.
  if (!decisionsAvailable(c.env) || cleared.length === 0) {
    return c.json({
      available: decisionsAvailable(c.env),
      checked: cleared.length,
      pages_read: 0,
      flagged: [],
      verdict: verdictOf(tender, requirements),
    } as never);
  }

  const documents = await query<{ id: string; name: string }>(
    "SELECT id, name FROM documents WHERE tender_id = ? AND extract_status = 'ready' ORDER BY created_at",
    [id],
  );

  // Swept per document, not across the tender: a page number only means
  // anything inside the document it came from, and a flag nobody can turn back
  // into a place in a file is not evidence, it is a rumour.
  const flags = new Map<string, { requirement: string; label: string; document_id: string; document: string; page_no: number; probability: number }>();
  let pagesRead = 0;

  for (const doc of documents) {
    if (pagesRead >= MAX_PAGES_PER_SWEEP) break;
    const pages = await query<{ page_no: number; text: string }>(
      "SELECT page_no, text FROM document_pages WHERE document_id = ? ORDER BY page_no LIMIT ?",
      [doc.id, MAX_PAGES_PER_SWEEP - pagesRead],
    );
    pagesRead += pages.length;

    const imposed = await findImposed(
      c.env,
      pages,
      cleared.map((r) => ({ key: r.key, label: r.label, hint: r.hint })),
    );

    for (const flag of imposed) {
      const existing = flags.get(flag.key);
      if (existing && existing.probability >= flag.probability) continue;
      const requirement = cleared.find((r) => r.key === flag.key);
      flags.set(flag.key, {
        requirement: flag.key,
        label: requirement?.label ?? flag.key,
        document_id: doc.id,
        document: doc.name,
        page_no: flag.page_no,
        probability: flag.probability,
      });
    }
  }

  for (const flag of flags.values()) {
    const requirement = cleared.find((r) => r.key === flag.requirement);
    if (!requirement) continue;
    // Back to unresolved, never to failed. The second read is a prompt to look
    // again, and a model that decided a bid was lost would be exactly the
    // confident wrong answer this app exists to refuse.
    await run(
      `UPDATE findings
          SET status = 'unknown',
              rationale = ?,
              updated_at = datetime('now')
        WHERE requirement_id = ?`,
      [
        `A second read of ${flag.document}, page ${flag.page_no}, suggests this tender does impose this requirement. Read that page and settle the row.`,
        requirement.id,
      ],
    );
  }

  const after = await requirementsOf(id);
  return c.json({
    available: true,
    checked: cleared.length,
    pages_read: pagesRead,
    flagged: [...flags.values()],
    verdict: verdictOf(tender, after),
  } as never);
});

// ── Agent handoff ────────────────────────────────────────────────────
//
// Qualifying a tender runs on the org's agent, not in this app: reading a
// 300-page pack against seventeen criteria is judgment work that takes minutes.
// These routes are the handoff.
//
// They are deliberately NOT on the OpenAPI surface. The agent is the *target*
// of a dispatch, so publishing `/qualify` would let it hand a tender to itself
// — a loop the app has no way to break — and every published route costs
// context in every agent turn. The agent's side of this contract is the routes
// it already has: GET /api/tenders/{id}, GET /api/documents/{id}/pages and
// POST /api/tenders/{id}/findings.

/** The chosen agent, or null to let the platform resolve a single-agent org. */
async function configuredServerId(): Promise<string | null> {
  const row = await get<{ server_id: string }>("SELECT server_id FROM agent_config WHERE id = 1");
  return row?.server_id || null;
}

app.get("/api/agent", async (c) => {
  const servers = await listAgentServers(c.env);
  return c.json({
    // Distinct on purpose: "this deployment has no platform token"
    // (off-platform) is a different problem from "the platform didn't answer"
    // (transient).
    available: dispatchAvailable(c.env),
    reachable: servers !== null,
    server_id: await configuredServerId(),
    servers: servers ?? [],
  });
});

app.put("/api/agent", async (c) => {
  let body: { server_id?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const wanted = typeof body.server_id === "string" ? body.server_id.trim() : "";

  // Validated against the live list rather than stored blind: a mistyped or
  // decommissioned id would otherwise wedge every future run behind a platform
  // 404 the user has no way to interpret.
  if (wanted) {
    const servers = await listAgentServers(c.env);
    if (servers === null) return c.json({ error: "Cannot reach the platform to verify that agent." }, 503);
    if (!servers.some((s) => s.id === wanted)) return c.json({ error: "That agent isn't in your organization." }, 400);
  }

  await run(
    `INSERT INTO agent_config (id, server_id, updated_at) VALUES (1, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET server_id = excluded.server_id, updated_at = excluded.updated_at`,
    [wanted],
  );
  return c.json({ server_id: wanted || null });
});

/** Hand a tender to the agent. Returns the brief either way, so an unreachable
 *  platform degrades to "paste this into chat" rather than a dead end. */
app.post("/api/tenders/:id/qualify", async (c) => {
  const id = c.req.param("id");

  const tender = await get<{ id: string; name: string }>("SELECT id, name FROM tenders WHERE id = ?", [id]);
  if (!tender) return c.json({ error: "No such tender" }, 404);

  const requirementCount = await countOf("SELECT COUNT(*) AS n FROM requirements WHERE tender_id = ?", [id]);
  if (requirementCount === 0) {
    return c.json(
      { error: "This tender has no requirements yet — apply a pack first, or there is nothing to qualify against." },
      400,
    );
  }

  // Counts, not the rows: the agent reads those from GET /api/tenders/{id}.
  // See qualifyBrief — an instruction carrying seventeen hints is past the
  // platform's cap and cannot be dispatched at all.
  const documentCount = await countOf(
    "SELECT COUNT(*) AS n FROM documents WHERE tender_id = ? AND extract_status = 'ready'",
    [id],
  );
  if (documentCount === 0) {
    return c.json({ error: "No readable documents on this tender yet — upload the pack first." }, 400);
  }

  const brief = qualifyBrief({
    tenderId: id,
    tenderName: tender.name,
    appUrl: new URL(c.req.url).origin,
    documentCount,
    requirementCount,
  });

  const result = await dispatchTask(c.env, {
    instruction: brief,
    serverId: await configuredServerId(),
    // Keyed on the tender *and* how much there is to read, so re-running after
    // an addendum lands is a new task rather than a silently deduplicated
    // repeat of the first one. Addenda are the normal case in procurement.
    idempotencyKey: `tender:${id}:${documentCount}:${requirementCount}`,
  });

  if (result.ok) return c.json({ dispatched: true, brief });
  return c.json({ dispatched: false, brief, error: result.error, servers: result.servers });
});

export default app;
