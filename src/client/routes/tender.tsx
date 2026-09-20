import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, FileText, ScanSearch, Sparkles, Trash2, Upload } from "lucide-react";
import { api, type Requirement, type TenderDetail, type TenderDocument } from "../api";
import { Badge, Button, Card, CardTitle, Chip, Empty, Field, Row, Textarea, Toolbar } from "../components/ui";
import { FamilyBar, VerdictBadge, deadlineTone, deadlineWords, familyLabel } from "../components/verdict";

const STATUS_TONES: Record<string, "success" | "danger" | "warning" | "neutral"> = {
  met: "success",
  not_met: "danger",
  rejected: "warning",
  unknown: "warning",
  not_stated: "neutral",
};

const STATUS_WORDS: Record<string, string> = {
  met: "Met",
  not_met: "Not met",
  rejected: "Unresolved",
  unknown: "Unknown",
  not_stated: "Not asked for",
};

export default function Tender() {
  const { id = "" } = useParams();
  const [data, setData] = useState<TenderDetail | null>(null);
  const [documents, setDocuments] = useState<TenderDocument[]>([]);
  const [error, setError] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [recheck, setRecheck] = useState<{ checked: number; flagged: number } | null>(null);
  const [rechecking, setRechecking] = useState(false);

  const load = async () => {
    try {
      const [detail, docs] = await Promise.all([api.tender(id), api.documents(id)]);
      setData(detail);
      setDocuments(docs.documents);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  if (error) return <p className="p-6 text-sm text-danger">{error}</p>;
  if (!data) return null;

  const { tender, requirements, verdict, capabilities } = data;
  const blankCapabilities = capabilities.filter((c) => !c.value).length;
  const cleared = requirements.filter((r) => r.finding?.status === "not_stated").length;

  // A second read of the rows that were cleared without a quote. Offered
  // rather than run automatically: it costs a pass over the pack, and the
  // person looking at the verdict is the one who knows whether it is worth it.
  const runRecheck = async () => {
    setRechecking(true);
    setError("");
    try {
      const result = await api.recheck(id);
      if (!result.available) {
        setError("No decision model is configured on this deployment, so the cleared rows cannot be double-checked.");
      } else {
        setRecheck({ checked: result.checked, flagged: result.flagged.length });
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRechecking(false);
    }
  };

  const qualify = async () => {
    setBusy(true);
    setBrief("");
    try {
      const result = await api.qualify(id);
      // The brief is shown whether or not dispatch worked. An unreachable
      // platform degrades to "paste this into your agent", not a dead end.
      if (!result.dispatched) setBrief(result.brief);
      setError(result.error ?? "");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Toolbar
        title={tender.name}
        subtitle={[tender.buyer, tender.lot, tender.reference].filter(Boolean).join(" · ")}
      >
        <Link to="/tenders" className="text-muted hover:text-foreground" aria-label="Back to tenders">
          <ArrowLeft className="size-4" />
        </Link>
        <Button variant="primary" onClick={qualify} disabled={busy}>
          <Sparkles className="size-4" />
          {busy ? "Handing over…" : "Ask the agent"}
        </Button>
      </Toolbar>

      <div className="mx-auto max-w-5xl space-y-4 p-6">
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        {brief ? (
          <Card>
            <CardTitle>Hand this to your agent</CardTitle>
            <div className="px-5 pb-4">
              <p className="mb-2 text-sm text-muted">
                The app could not reach an agent, so here is the brief to paste into a chat instead.
              </p>
              <pre className="max-h-64 overflow-auto rounded-sm bg-sunken p-3 text-xs whitespace-pre-wrap">{brief}</pre>
            </div>
          </Card>
        ) : null}

        {/* The verdict, first and largest. Everything below it is the working
            out; a screen that makes you scroll to find the call is a screen
            people read the wrong answer off. */}
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <VerdictBadge verdict={verdict.verdict} />
                {verdict.scored.total > 0 ? (
                  <Chip>
                    {verdict.scored.answered}/{verdict.scored.total} scored criteria answered
                  </Chip>
                ) : null}
              </div>
              <p className="mt-2 max-w-xl text-[1.0625rem] font-medium">{verdict.reason}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-sm">
              <span className={toneClass(deadlineTone(verdict.days_to_deadline))}>
                {deadlineWords(verdict.days_to_deadline, "submission")}
              </span>
              <span className={toneClass(deadlineTone(verdict.days_to_clarification_deadline))}>
                {deadlineWords(verdict.days_to_clarification_deadline, "clarification window")}
              </span>
            </div>
          </div>

          {verdict.families.length > 0 ? (
            <div className="space-y-2.5 border-t border-border px-5 py-4">
              {verdict.families.map((roll) => (
                <FamilyBar key={roll.family} roll={roll} />
              ))}
            </div>
          ) : null}

          {verdict.blockers.length > 0 ? (
            <div className="border-t border-border px-5 py-4">
              <p className="mb-2 text-sm font-medium text-danger">What stops this bid</p>
              <ul className="space-y-2">
                {verdict.blockers.map((b) => (
                  <li key={b.key} className="text-sm">
                    <span className="font-medium">{b.label}</span>
                    <span className="text-muted">
                      {": "}they ask for {b.stated || "it"}; we have {b.our_evidence || "nothing recorded"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {verdict.open_questions.length > 0 ? (
            <div className="border-t border-border px-5 py-4">
              <p className="mb-2 text-sm font-medium">
                Unresolved{" "}
                <span className="font-normal text-muted">
                  ({verdict.open_questions.length}). These hold the verdict, they do not fail it
                </span>
              </p>
              <ul className="space-y-1.5">
                {verdict.open_questions.slice(0, 6).map((q) => (
                  <li key={q.key} className="text-sm">
                    <span className="font-medium">{q.label}</span>
                    <span className="text-muted">: {q.reason}</span>
                  </li>
                ))}
              </ul>
              {verdict.open_questions.length > 6 ? (
                <p className="mt-1.5 text-xs text-faint">
                  and {verdict.open_questions.length - 6} more in the list below
                </p>
              ) : null}
            </div>
          ) : null}

          {cleared > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
              <p className="text-sm text-muted">
                {recheck
                  ? recheck.flagged === 0
                    ? `Read again: none of the ${recheck.checked} cleared requirements appear in the pack after all.`
                    : `Read again: ${recheck.flagged} of ${recheck.checked} cleared requirements do appear in the pack. They are back on the list.`
                  : `${cleared} ${cleared === 1 ? "requirement was" : "requirements were"} cleared as not asked for. That is the one answer with no quote behind it.`}
              </p>
              <Button onClick={runRecheck} disabled={rechecking}>
                <ScanSearch className="size-4" />
                {rechecking ? "Reading the pack…" : "Double-check"}
              </Button>
            </div>
          ) : null}

          {blankCapabilities > 0 ? (
            <div className="border-t border-border px-5 py-3 text-sm text-muted">
              {blankCapabilities} of {capabilities.length} entries in{" "}
              <Link to="/profile" className="link">
                our profile
              </Link>{" "}
              are still blank. A blank entry cannot clear a requirement.
            </div>
          ) : null}
        </Card>

        <Documents tenderId={id} documents={documents} onChange={load} />

        <Requirements requirements={requirements} documents={documents} onChange={load} />

        <Decision tender={tender} onChange={load} />
      </div>
    </>
  );
}

function toneClass(tone: string) {
  return tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-muted";
}

function Documents({
  tenderId,
  documents,
  onChange,
}: {
  tenderId: string;
  documents: TenderDocument[];
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState("itt");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    try {
      for (const file of Array.from(files)) await api.upload(tenderId, file, kind);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <Card>
      <CardTitle
        count={documents.length || undefined}
        action={
          <>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Document type"
              className="h-7 rounded-sm bg-surface px-2 text-sm shadow-raised focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="itt">Instructions to tenderers</option>
              <option value="specification">Specification</option>
              <option value="sq">Selection questionnaire</option>
              <option value="contract">Contract</option>
              <option value="pricing">Pricing</option>
              <option value="other">Other</option>
            </select>
            <Button onClick={() => input.current?.click()} disabled={busy}>
              <Upload className="size-4" />
              {busy ? "Reading…" : "Add"}
            </Button>
          </>
        }
      >
        The pack
      </CardTitle>

      <input
        ref={input}
        type="file"
        multiple
        accept=".pdf,.docx,.txt,.md"
        className="hidden"
        onChange={(e) => upload(e.target.files)}
      />

      {error ? <p className="px-5 pb-3 text-sm text-danger">{error}</p> : null}

      {documents.length === 0 ? (
        <Empty
          title="Nothing to read yet"
          hint="PDF, Word or plain text. A scanned file has no text layer, so it needs an OCR'd copy first."
        />
      ) : (
        documents.map((doc) => (
          <Row key={doc.id}>
            <FileText className="size-4 shrink-0 text-faint" />
            <a href={`/api/documents/${doc.id}/file`} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
              <span className="block truncate text-sm">{doc.name}</span>
              <span className="text-xs text-muted">
                {doc.kind.replace(/_/g, " ")} ·{" "}
                {doc.extract_status === "ready"
                  ? `${doc.page_count} ${doc.locator_kind === "page" ? "pages" : "blocks"}`
                  : doc.extract_status === "failed"
                    ? doc.extract_error || "could not be read"
                    : "reading…"}
              </span>
            </a>
            {doc.extract_status === "failed" ? <Badge tone="danger">Unreadable</Badge> : null}
            <Button
              variant="ghost"
              title="Remove"
              onClick={() => api.deleteDocument(doc.id).then(onChange)}
            >
              <Trash2 className="size-4" />
            </Button>
          </Row>
        ))
      )}
    </Card>
  );
}

function Requirements({
  requirements,
  documents,
  onChange,
}: {
  requirements: Requirement[];
  documents: TenderDocument[];
  onChange: () => void;
}) {
  const byFamily = new Map<string, Requirement[]>();
  for (const req of requirements) {
    const list = byFamily.get(req.family) ?? [];
    list.push(req);
    byFamily.set(req.family, list);
  }

  const documentName = (docId: string | null) =>
    documents.find((d) => d.id === docId)?.name ?? "a document since removed";

  return (
    <Card>
      <CardTitle count={requirements.length || undefined}>Requirements</CardTitle>

      {requirements.length === 0 ? (
        <Empty title="No requirements on this tender" hint="Load a pack to start from a standard question set." />
      ) : (
        [...byFamily.entries()].map(([family, rows]) => (
          <div key={family} className="border-b border-border last:border-b-0">
            <div className="bg-sunken px-5 py-1.5 text-xs font-medium text-muted">{familyLabel(family)}</div>
            {rows.map((req) => (
              <div key={req.id} className="px-5 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{req.label}</span>
                      {req.obligation !== "mandatory" ? <Chip>{req.obligation}</Chip> : null}
                    </div>
                    {!req.finding && req.hint ? (
                      <p className="mt-0.5 max-w-2xl text-xs text-muted">{req.hint}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {req.finding ? (
                      <Badge tone={STATUS_TONES[req.finding.status] ?? "neutral"}>
                        {STATUS_WORDS[req.finding.status] ?? req.finding.status}
                      </Badge>
                    ) : (
                      <Chip>not read</Chip>
                    )}
                    <Button
                      variant="ghost"
                      title="This tender does not ask for it. Remove the row"
                      onClick={() => api.deleteRequirement(req.id).then(onChange)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {req.finding ? (
                  <div className="mt-2 space-y-1.5 text-sm">
                    {req.finding.stated ? (
                      <p>
                        <span className="text-muted">They ask for</span> {req.finding.stated}
                      </p>
                    ) : null}
                    {req.finding.our_evidence ? (
                      <p>
                        <span className="text-muted">We have</span> {req.finding.our_evidence}
                      </p>
                    ) : null}
                    {req.finding.quote ? (
                      // The receipt. Rendered as the source's own words, in a
                      // sunken block rather than the app's voice, with the page
                      // it was found on — the point of the whole app is that
                      // this is checkable in one click.
                      <div className="rounded-sm bg-sunken p-2.5">
                        <p className="text-[0.8125rem] italic text-muted">“{req.finding.quote}”</p>
                        <p className="mt-1 text-xs text-faint">
                          {req.finding.document_id ? (
                            <a
                              href={`/api/documents/${req.finding.document_id}/file`}
                              target="_blank"
                              rel="noreferrer"
                              className="link"
                            >
                              {documentName(req.finding.document_id)}
                            </a>
                          ) : (
                            documentName(null)
                          )}
                          {req.finding.page_no ? `, p.${req.finding.page_no}` : null}
                        </p>
                      </div>
                    ) : null}
                    {req.finding.status === "rejected" && req.finding.rejected_reason ? (
                      <p className="text-[0.8125rem] text-warning">
                        Citation refused: {req.finding.rejected_reason}
                      </p>
                    ) : null}
                    {req.finding.rationale ? (
                      <p className="text-[0.8125rem] text-muted">{req.finding.rationale}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ))
      )}
    </Card>
  );
}

/**
 * The override.
 *
 * The computed verdict is evidence, not authority. Teams bid on a technical
 * no-go (with an avvalimento, a partner, a waiver they have already agreed)
 * and walk away from a clean go for reasons no pack models. Recording that
 * here keeps the findings honest — the alternative is someone editing rows
 * until the machine agrees with the decision they already made.
 */
function Decision({ tender, onChange }: { tender: TenderDetail["tender"]; onChange: () => void }) {
  const [status, setStatus] = useState(tender.status);
  const [note, setNote] = useState(tender.decision_note);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    await api.updateTender(tender.id, { status, decision_note: note });
    setSaved(true);
    onChange();
  };

  const dirty = status !== tender.status || note !== tender.decision_note;

  return (
    <Card>
      <CardTitle>What we decided</CardTitle>
      <div className="space-y-3 px-5 pb-4">
        <Field label="Outcome">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setSaved(false);
            }}
            className="h-8 w-full rounded-sm bg-surface px-2 text-[0.9375rem] shadow-edge focus:outline-none focus:ring-2 focus:ring-ring sm:w-64"
          >
            <option value="open">Still deciding</option>
            <option value="submitted">Submitted</option>
            <option value="abandoned">Did not bid</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </select>
        </Field>
        <Field label="Why" hint="Especially when it goes against the verdict above">
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setSaved(false);
            }}
            placeholder="Bidding anyway. The Plus assessment is booked for the 30th and the buyer confirmed it can be evidenced at award."
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={save} disabled={!dirty}>
            Save
          </Button>
          {saved && !dirty ? <span className="text-sm text-muted">Saved</span> : null}
        </div>
      </div>
    </Card>
  );
}
