import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, type Pack, type TenderRow } from "../api";
import { Button, Card, Empty, Field, Input, Modal, Row, Toolbar } from "../components/ui";
import { VerdictBadge, deadlineTone, deadlineWords } from "../components/verdict";

export default function Tenders() {
  const [tenders, setTenders] = useState<TenderRow[] | null>(null);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const load = () =>
    api
      .tenders("limit=50")
      .then((r) => setTenders(r.tenders))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api.packs().then((r) => setPacks(r.packs)).catch(() => setPacks([]));
  }, []);

  return (
    <>
      <Toolbar title="Tenders" subtitle={tenders ? `${tenders.length} on the board` : undefined}>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          New tender
        </Button>
      </Toolbar>

      <div className="mx-auto max-w-5xl p-6">
        {error ? <p className="mb-4 text-sm text-danger">{error}</p> : null}

        {tenders === null ? null : tenders.length === 0 ? (
          <Empty
            title="No tenders yet"
            hint="Add the one on your desk. Load a requirement pack with it and the questions are already there."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New tender
              </Button>
            }
          />
        ) : (
          <Card>
            {tenders.map((t) => (
              <Row key={t.id}>
                <Link to={`/tenders/${t.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{t.name}</div>
                    <div className="truncate text-xs text-muted">
                      {[t.buyer, t.lot, t.reference].filter(Boolean).join(" · ") || "No buyer recorded"}
                    </div>
                  </div>
                  <span
                    className={`hidden shrink-0 text-xs sm:block ${
                      deadlineTone(t.days_to_deadline) === "danger"
                        ? "text-danger"
                        : deadlineTone(t.days_to_deadline) === "warning"
                          ? "text-warning"
                          : "text-muted"
                    }`}
                  >
                    {deadlineWords(t.days_to_deadline)}
                  </span>
                  <VerdictBadge verdict={t.verdict} />
                </Link>
              </Row>
            ))}
          </Card>
        )}
      </div>

      <NewTender
        open={creating}
        packs={packs}
        onClose={() => setCreating(false)}
        onCreated={() => {
          setCreating(false);
          load();
        }}
      />
    </>
  );
}

function NewTender({
  open,
  packs,
  onClose,
  onCreated,
}: {
  open: boolean;
  packs: Pack[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    buyer: "",
    reference: "",
    lot: "",
    deadline_at: "",
    clarification_deadline_at: "",
    pack_id: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Default to the only pack rather than making the user pick from a list of
  // one. A tender created with no requirements has nothing to qualify against,
  // which is the emptiest possible first run.
  useEffect(() => {
    if (packs.length && !form.pack_id) setForm((f) => ({ ...f, pack_id: packs[0].id }));
  }, [packs]);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  const submit = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const created = await api.createTender({ ...form, name: form.name.trim() });
      onCreated();
      navigate(`/tenders/${created.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pack = packs.find((p) => p.id === form.pack_id);

  return (
    <Modal open={open} onClose={onClose} title="New tender" description="Anything you do not have yet can wait.">
      <div className="space-y-3">
        <Field label="What is it for">
          <Input value={form.name} onChange={set("name")} placeholder="Managed IT support 2027-2030" autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Buyer">
            <Input value={form.buyer} onChange={set("buyer")} placeholder="Coventry City Council" />
          </Field>
          <Field label="Their reference">
            <Input value={form.reference} onChange={set("reference")} placeholder="CCC-2026-ITS-041" />
          </Field>
          <Field label="Lot" hint="Leave blank if the tender has none">
            <Input value={form.lot} onChange={set("lot")} placeholder="Lot 1" />
          </Field>
          <Field label="Submission deadline">
            <Input type="date" value={form.deadline_at} onChange={set("deadline_at")} />
          </Field>
          <Field
            label="Clarification deadline"
            hint="The quieter one: after it closes an unclear requirement can only be guessed at"
          >
            <Input
              type="date"
              value={form.clarification_deadline_at}
              onChange={set("clarification_deadline_at")}
            />
          </Field>
        </div>

        {packs.length > 0 ? (
          <Field
            label="Requirement pack"
            hint={pack ? `${pack.requirement_count} requirements, ${pack.mandatory_count} mandatory · ${pack.publisher}` : undefined}
          >
            <select
              value={form.pack_id}
              onChange={set("pack_id")}
              className="h-8 w-full rounded-sm bg-surface px-2 text-[0.9375rem] shadow-edge focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value="">None. I will add the requirements myself</option>
            </select>
          </Field>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={saving || !form.name.trim()}>
            {saving ? "Creating…" : "Create tender"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
